/* CorteFlow · Supabase integration */
const CORTEFLOW_SUPABASE_URL = "https://vzkujityzkyympfapeol.supabase.co";
const CORTEFLOW_SUPABASE_KEY = "sb_publishable_qsCN5Yug2YC_YZBgY0ZZbA_5cSz4lAV";
const cfSupabase = window.supabase.createClient(CORTEFLOW_SUPABASE_URL, CORTEFLOW_SUPABASE_KEY);
let cfSnapshot = null;
let cfSaveQueue = Promise.resolve();
let cfBooted = false;

const cfTime = v => String(v || "09:00").slice(0,5);
const cfClone = v => JSON.parse(JSON.stringify(v));
const cfSame = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const cfError = (e, fallback) => { console.error("CorteFlow/Supabase:", e); toast(e?.message || fallback || "Não foi possível salvar os dados.", true); };

async function cfLoadPublic() {
  const [sr, br, hr, sh] = await Promise.all([
    cfSupabase.from("services").select("*").order("name"),
    cfSupabase.from("barbers").select("*").order("name"),
    cfSupabase.from("business_settings").select("*").eq("id", true).maybeSingle(),
    cfSupabase.from("barber_shifts").select("*")
  ]);
  for (const r of [sr,br,hr,sh]) if (r.error) throw r.error;
  db.services = (sr.data || []).map(x => ({id:x.id,name:x.name,description:x.description,duration:x.duration_minutes,price:Number(x.price),active:x.active}));
  db.barbers = (br.data || []).map(x => ({id:x.id,name:x.name,specialty:x.specialty,phone:x.phone,active:x.active,userId:x.user_id}));
  const h = hr.data || {};
  db.hours = {open:cfTime(h.opening_time),close:cfTime(h.closing_time),slot:h.slot_minutes||30,cancelHours:h.cancellation_hours??3,days:h.working_days||[1,2,3,4,5,6]};
  db.barberShifts = {};
  (sh.data || []).forEach(x => db.barberShifts[x.barber_id] = {days:x.working_days||[],open:cfTime(x.opening_time),close:cfTime(x.closing_time)});
  db.users = [];
  db.appointments = [];
}
function cfMapAppointment(x) {
  return {id:x.id,userId:x.user_id,serviceId:x.service_id,barberId:x.barber_id,date:String(x.appointment_date).slice(0,10),time:cfTime(x.appointment_time),status:x.status,created:x.created_at,duration:x.duration_minutes,price:Number(x.service_price)};
}
async function cfLoadSignedInUser(authUser) {
  const pr = await cfSupabase.from("profiles").select("*").eq("id",authUser.id).maybeSingle();
  if (pr.error) throw pr.error;
  if (!pr.data) throw new Error("Seu perfil ainda não foi criado. Entre em contato com o administrador.");
  const profile = pr.data;
  const [usersResult, appointmentsResult] = await Promise.all([
    cfSupabase.from("profiles").select("*"),
    cfSupabase.from("appointments").select("*").order("appointment_date").order("appointment_time")
  ]);
  if (usersResult.error) throw usersResult.error;
  if (appointmentsResult.error) throw appointmentsResult.error;
  const profiles = usersResult.data || [profile];
  db.users = profiles.map(x => ({id:x.id,name:x.name,email:x.email,phone:x.phone||"",role:x.role}));
  const barberByUser = db.barbers.find(x => x.userId === authUser.id);
  currentUser = {id:profile.id,name:profile.name,email:profile.email,phone:profile.phone||"",role:profile.role,barberId:barberByUser?.id||null};
  db.appointments = (appointmentsResult.data||[]).map(cfMapAppointment);
  if (currentUser.role === "barber" && !currentUser.barberId) {
    throw new Error("Sua conta está marcada como barbeiro, mas ainda não foi vinculada a um profissional. Peça ao administrador para fazer essa associação.");
  }
}
function cfTakeSnapshot() {
  cfSnapshot = {
    services:cfClone(db.services), barbers:cfClone(db.barbers),
    appointments:cfClone(db.appointments), hours:cfClone(db.hours),
    barberShifts:cfClone(db.barberShifts)
  };
}
async function cfUpsert(table, row) {
  const {error} = await cfSupabase.from(table).upsert(row);
  if (error) throw error;
}
async function cfPersist(target) {
  if (!cfSupabase.auth.getSession || !cfSnapshot) return;
  const session = await cfSupabase.auth.getSession();
  if (!session.data.session) return;
  const old = cfSnapshot;
  for (const x of target.services) {
    const prev = old.services.find(y=>y.id===x.id);
    if (!prev || !cfSame(prev,x)) await cfUpsert("services",{id:x.id,name:x.name,description:x.description||"",duration_minutes:x.duration,price:x.price,active:x.active});
  }
  for (const x of target.barbers) {
    const prev = old.barbers.find(y=>y.id===x.id);
    if (!prev || !cfSame(prev,x)) await cfUpsert("barbers",{id:x.id,name:x.name,specialty:x.specialty||"",phone:x.phone||null,active:x.active,user_id:x.userId||null});
  }
  for (const x of target.appointments) {
    const prev = old.appointments.find(y=>y.id===x.id);
    if (!prev || !cfSame(prev,x)) {
      const svc = target.services.find(s=>s.id===x.serviceId) || {};
      await cfUpsert("appointments",{
        id:x.id,user_id:x.userId,service_id:x.serviceId,barber_id:x.barberId,
        appointment_date:x.date,appointment_time:x.time,
        duration_minutes:x.duration||svc.duration,service_price:x.price??svc.price,
        status:x.status, ...(x.created?{created_at:x.created}:{})
      });
    }
  }
  if (!cfSame(old.hours,target.hours)) await cfUpsert("business_settings",{
    id:true,opening_time:target.hours.open,closing_time:target.hours.close,
    working_days:target.hours.days,slot_minutes:target.hours.slot,cancellation_hours:target.hours.cancelHours,
    timezone:"America/Sao_Paulo"
  });
  for (const [barberId,shift] of Object.entries(target.barberShifts||{})) {
    const prev = old.barberShifts?.[barberId];
    if (!prev || !cfSame(prev,shift)) await cfUpsert("barber_shifts",{
      barber_id:barberId,working_days:shift.days,opening_time:shift.open,closing_time:shift.close
    });
  }
  cfSnapshot = {services:cfClone(target.services),barbers:cfClone(target.barbers),appointments:cfClone(target.appointments),hours:cfClone(target.hours),barberShifts:cfClone(target.barberShifts)};
}
saveDB = function() {
  if (!cfBooted || !cfSnapshot) return;
  const target = cfClone(db);
  cfSaveQueue = cfSaveQueue.then(()=>cfPersist(target)).catch(e=>cfError(e,"Falha ao sincronizar com o banco de dados."));
};
loginPage = function() {
  return authLayout(`<h1>Bem-vindo ao CorteFlow</h1><p class="muted">Entre na sua conta para continuar.</p>
  <form onsubmit="login(event)"><div class="field"><label>E-mail</label><input name="email" type="email" required placeholder="voce@email.com" autocomplete="email"></div>
  <div class="field"><label>Senha</label><input name="password" type="password" required placeholder="Sua senha" autocomplete="current-password"></div>
  <div style="text-align:right"><button type="button" class="text-button" onclick="navigate('forgot')">Esqueceu sua senha?</button></div>
  <button class="btn full" type="submit">Entrar</button></form><div style="text-align:center;margin:14px 0;color:#858994;font-size:12px">ou</div>
  <button class="btn light full" onclick="navigate('register')">Criar uma conta</button>
  <div class="auth-foot">Acesso seguro para clientes, barbeiros e administradores.<br><button class="text-button" onclick="navigate('home')">← Voltar ao início</button></div>`);
};
login = async function(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  const {data,error} = await cfSupabase.auth.signInWithPassword({email:String(f.get("email")).trim().toLowerCase(),password:String(f.get("password"))});
  if (error) return toast("E-mail ou senha incorretos.",true);
  try {
    await cfLoadSignedInUser(data.user);
    cfTakeSnapshot();
    navigate(currentUser.role==="admin"?"admin":currentUser.role==="barber"?"barber":"client");
    toast("Bem-vindo(a), "+currentUser.name+"!");
  } catch(err) { await cfSupabase.auth.signOut(); currentUser=null; cfError(err,"Não foi possível carregar seu perfil."); }
};
register = async function(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  if (f.get("password")!==f.get("confirm")) return toast("As senhas não conferem.",true);
  const {data,error} = await cfSupabase.auth.signUp({
    email:String(f.get("email")).trim().toLowerCase(),password:String(f.get("password")),
    options:{data:{name:String(f.get("name")).trim(),phone:String(f.get("phone")).trim()},emailRedirectTo:window.location.origin}
  });
  if (error) return toast(error.message,true);
  if (!data.session) {
    navigate("login");
    toast("Cadastro recebido! Confirme seu e-mail pelo link enviado para entrar.");
    return;
  }
  try {
    await cfLoadSignedInUser(data.user);
    cfTakeSnapshot();
    navigate("client");
    toast("Conta criada com sucesso!");
  } catch(err) { cfError(err,"Conta criada; aguarde a confirmação do perfil e entre novamente."); }
};
forgotPage = function() {
  return authLayout(`<h1>Recuperar senha</h1><p class="muted">Informe seu e-mail para receber um link de recuperação.</p>
  <form onsubmit="sendPasswordReset(event)"><div class="field"><label>E-mail</label><input name="email" type="email" required placeholder="voce@email.com"></div>
  <button class="btn full">Enviar instruções</button></form><div class="auth-foot">Lembrou da senha? <button class="text-button" onclick="navigate('login')">Entrar</button></div>`);
};
sendPasswordReset = async function(e) {
  e.preventDefault();
  const email=String(new FormData(e.target).get("email")).trim().toLowerCase();
  const {error}=await cfSupabase.auth.resetPasswordForEmail(email,{redirectTo:window.location.origin});
  if(error) return toast(error.message,true);
  toast("Se o e-mail estiver cadastrado, você receberá o link de recuperação.");
  navigate("login");
};
saveProfile = async function(e) {
  e.preventDefault();
  const f=new FormData(e.target), name=String(f.get("name")).trim(), phone=String(f.get("phone")).trim(), email=String(f.get("email")).trim().toLowerCase();
  const {error}=await cfSupabase.from("profiles").update({name,phone}).eq("id",currentUser.id);
  if(error) return cfError(error,"Não foi possível atualizar o perfil.");
  currentUser.name=name;currentUser.phone=phone;
  const u=db.users.find(x=>x.id===currentUser.id);if(u){u.name=name;u.phone=phone;}
  if(email && email!==currentUser.email) {
    const changed=await cfSupabase.auth.updateUser({email});
    if(changed.error) return cfError(changed.error,"Não foi possível solicitar a alteração do e-mail.");
    toast("Dados salvos. Enviamos uma confirmação para o novo e-mail.");
  } else toast("Perfil atualizado.");
  closeModal();render();
};
savePassword = async function(e) {
  e.preventDefault();
  const f=new FormData(e.target), next=String(f.get("next"));
  if(next!==f.get("confirm")) return toast("As senhas não conferem.",true);
  const verified=await cfSupabase.auth.signInWithPassword({email:currentUser.email,password:String(f.get("old"))});
  if(verified.error) return toast("A senha atual está incorreta.",true);
  const {error}=await cfSupabase.auth.updateUser({password:next});
  if(error) return cfError(error,"Não foi possível alterar a senha.");
  closeModal();toast("Senha alterada com sucesso.");
};
confirmBooking = async function() {
  const bid=availableBarberId();
  if(!bid||!book.serviceId||!book.date||!book.time) return toast("Confira os dados do agendamento.",true);
  if(book.date<todayISO()||(book.date===todayISO()&&book.time<=new Date().toTimeString().slice(0,5))) return toast("Não é possível agendar em horário passado.",true);
  if(!barberWorksOn(bid,book.date)||!barberHasShift(bid,book.time,service(book.serviceId).duration)) return toast("Este horário está fora do turno do barbeiro. Escolha outro.",true);
  if(isBusy(bid,book.date,book.time,service(book.serviceId).duration,book.editId)) return toast("Este horário acabou de ficar indisponível. Escolha outro.",true);
  if(book.editId) {
    const a=db.appointments.find(x=>x.id===book.editId); if(!a) return;
    a.date=book.date;a.time=book.time;a.barberId=bid;a.status="Agendado";
    saveDB();book.editId="";book.step=1;navigate("bookings");toast("Agendamento alterado com sucesso.");return;
  }
  db.appointments.push({id:crypto.randomUUID(),userId:currentUser.id,serviceId:book.serviceId,barberId:bid,date:book.date,time:book.time,status:"Agendado",created:new Date().toISOString()});
  saveDB();book.step=1;navigate("booking-success");toast("Agendamento realizado com sucesso!");
};
createAdminAppointment = async function(e) {
  e.preventDefault();
  const f=new FormData(e.target),a={id:crypto.randomUUID(),userId:f.get("userId"),serviceId:f.get("serviceId"),barberId:f.get("barberId"),date:f.get("date"),time:f.get("time"),status:"Confirmado",created:new Date().toISOString()};
  if(a.date<todayISO()||(a.date===todayISO()&&a.time<=new Date().toTimeString().slice(0,5))) return toast("Escolha uma data e horário futuros.",true);
  if(!db.hours.days.includes(new Date(a.date+"T12:00:00").getDay())) return toast("A barbearia não funciona neste dia.",true);
  if(timeToMin(a.time)<timeToMin(db.hours.open)||timeToMin(a.time)+service(a.serviceId).duration>timeToMin(db.hours.close)) return toast("Horário fora do funcionamento da barbearia.",true);
  if(isBusy(a.barberId,a.date,a.time,service(a.serviceId).duration)) return toast("O barbeiro já possui um agendamento nesse horário.",true);
  db.appointments.push(a);saveDB();closeModal();render();toast("Agendamento criado.");
};
logout = async function() {
  const {error}=await cfSupabase.auth.signOut();
  if(error) return cfError(error,"Não foi possível sair.");
  currentUser=null;db.users=[];db.appointments=[];cfSnapshot=null;book={step:1,serviceId:"",barberId:"",date:"",time:""};
  navigate("home");toast("Você saiu da sua conta.");
};

async function cfBoot() {
  try {
    localStorage.removeItem("corteflow_db");
    db.users=[];db.appointments=[];
    await cfLoadPublic();
    const {data,error}=await cfSupabase.auth.getSession();
    if(error) throw error;
    if(data.session) await cfLoadSignedInUser(data.session.user);
    cfTakeSnapshot();
    cfBooted=true;
    render();
  } catch(e) {
    console.error("CorteFlow initialization:",e);
    toast("Não foi possível carregar os dados. Atualize a página.",true);
  }
}
cfBoot();
