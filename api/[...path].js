// QR Attendance API for Vercel. State lives in Upstash Redis; QR tokens are derived from the clock (no timers needed).
const crypto=require('crypto');
const RU=process.env.UPSTASH_REDIS_REST_URL||process.env.KV_REST_API_URL, RT=process.env.UPSTASH_REDIS_REST_TOKEN||process.env.KV_REST_API_TOKEN;
const PASS=process.env.LECTURER_PASSWORD||'', SECRET=process.env.AUTH_SECRET||('s:'+PASS);
const AL='abcdefghjkmnpqrstuvwxyz23456789';
const hm=m=>crypto.createHmac('sha256',SECRET).update(m).digest();
const tokenFor=(sid,w)=>Array.from(hm(sid+':'+w).subarray(0,6),b=>AL[b%31]).join('');
const win=()=>Math.floor(Date.now()/30000);
const okTok=(s,t)=>!!(s&&s.active&&t&&[0,1,2,3,4].some(i=>tokenFor(s.sid,win()-i)===String(t)));
const nid=s=>String(s||'').toUpperCase().replace(/\s+/g,'');
const dist=(a,b,c,e)=>{const r=Math.PI/180,x=(c-a)*r,y=(e-b)*r,s=Math.sin(x/2)**2+Math.cos(a*r)*Math.cos(c*r)*Math.sin(y/2)**2;return 2*6371000*Math.asin(Math.sqrt(s))};
async function redis(path,payload){const r=await fetch(RU+path,{method:'POST',headers:{authorization:'Bearer '+RT},body:JSON.stringify(payload)});const j=await r.json();if(!r.ok)throw new Error('Redis: '+(j.error||r.status));return j}
const cmd=async(...a)=>{const j=await redis('',a);if(j.error)throw new Error(j.error);return j.result};
const pipe=a=>redis('/pipeline',a);
const mk=()=>{const e=Date.now()+12*3600e3;return e+'.'+hm('admin'+e).toString('hex')};
const isAdmin=k=>{const [e,h]=String(k||'').split('.');return !!(e&&h&&+e>Date.now()&&h===hm('admin'+e).toString('hex'))};
const getSession=async()=>{const s=await cmd('GET','session');return s?JSON.parse(s):null};
const flat=a=>{const o=[];for(let i=0;i<(a||[]).length;i+=2)o.push(JSON.parse(a[i+1]));return o};

module.exports=async(req,res)=>{
 const send=(c,o)=>res.status(c).json(o);
 try{
  if(!RU||!RT)return send(500,{error:'Database not connected. Add Upstash Redis in Vercel Storage.'});
  const u=new URL(req.url,'http://x'),p=u.pathname;
  let b=req.body;if(typeof b==='string'){try{b=JSON.parse(b)}catch{b={}}}b=b||{};
  const k=(req.headers.authorization||'').slice(7)||u.searchParams.get('k');
  if(p==='/api/login'&&req.method==='POST'){
   if(!PASS)return send(500,{error:'LECTURER_PASSWORD is not set in Vercel.'});
   const a=Buffer.from(String(b.password||'')),c=Buffer.from(PASS);
   if(a.length===c.length&&crypto.timingSafeEqual(a,c))return send(200,{key:mk()});
   await new Promise(r=>setTimeout(r,1000));return send(401,{error:'Wrong password'})}
  /* ---- lecturer ---- */
  if(p.startsWith('/api/admin/')){
   if(!isAdmin(k))return send(401,{error:'Not signed in'});
   if(p==='/api/admin/roster'&&req.method==='POST'){
     const rows=(b.rows||[]).map(r=>[nid(r[0]),r[1],r[2],r[3]]).filter(r=>r[0]&&r[1]);
     if(rows.length)await pipe(rows.map(r=>['HSET','roster',r[0],JSON.stringify({id:r[0],name:String(r[1]),programme:String(r[2]||''),level:String(r[3]||'')})]));
     return send(200,{saved:rows.length,total:await cmd('HLEN','roster')})}
   if(p==='/api/admin/start'&&req.method==='POST'){
     if(typeof b.lat!=='number'||typeof b.lng!=='number')return send(400,{error:'Location missing'});
     const s={sid:crypto.randomBytes(5).toString('hex'),course:String(b.course||'Class').slice(0,100),lat:b.lat,lng:b.lng,radius:Math.min(200,Math.max(5,+b.radius||20)),active:true,started:Date.now()};
     await cmd('SET','session',JSON.stringify(s));return send(200,{ok:1})}
   if(p==='/api/admin/end'&&req.method==='POST'){const s=await getSession();if(s){s.active=false;await cmd('SET','session',JSON.stringify(s))}return send(200,{ok:1})}
   if(p==='/api/admin/live'){const s=await getSession();if(!s)return send(200,{session:null});
     const [recs,n]=(await pipe([['HGETALL','rec:'+s.sid],['HLEN','roster']])).map(x=>x.result);
     return send(200,{session:{course:s.course,radius:s.radius,active:s.active,sid:s.sid,token:tokenFor(s.sid,win())},roster:n,records:flat(recs).sort((a,c)=>c.ts-a.ts)})}
   if(p.startsWith('/api/admin/selfie/')){const [,,,,sid,id]=p.split('/');const img=await cmd('GET','img:'+sid+':'+decodeURIComponent(id));
     const m=/^data:image\/jpeg;base64,(.+)$/.exec(img||'');if(!m)return send(404,{});res.setHeader('content-type','image/jpeg');return res.status(200).end(Buffer.from(m[1],'base64'))}
   if(p==='/api/admin/export'){const s=await getSession();const q=x=>'"'+String(x).replace(/"/g,'""')+'"';
     const rows=s?flat(await cmd('HGETALL','rec:'+s.sid)):[];
     res.setHeader('content-type','text/csv');res.setHeader('content-disposition','attachment; filename="attendance.csv"');
     return res.status(200).end(['ID,Name,Programme,Level,Time,Distance_m,GPS_accuracy_m'].concat(rows.map(r=>[r.id,r.name,r.programme,r.level,new Date(r.ts).toISOString(),r.dist,r.acc].map(q).join(','))).join('\n'))}
   return send(404,{error:'Not found'})}
  /* ---- student ---- */
  const s=await getSession();
  if(p==='/api/status')return okTok(s,u.searchParams.get('t'))?send(200,{ok:true,course:s.course,radius:s.radius}):send(200,{ok:false});
  const expired='This QR code has expired. Scan the code currently on the screen.';
  if(p==='/api/lookup'&&req.method==='POST'){
   if(!okTok(s,b.t))return send(403,{error:expired});
   const r=await cmd('HGET','roster',nid(b.id));return r?send(200,JSON.parse(r)):send(404,{error:'That ID is not on the class list.'})}
  if(p==='/api/attend'&&req.method==='POST'){
   if(!okTok(s,b.t))return send(403,{error:expired});
   const id=nid(b.id),sr=await cmd('HGET','roster',id);if(!sr)return send(404,{error:'That ID is not on the class list.'});
   const st=JSON.parse(sr),dev=String(b.device||'').slice(0,60);
   const used=await cmd('HGET','dev:'+s.sid,dev);
   if(used&&used!==id)return send(409,{error:'This device has already been used to register another student.'});
   if(typeof b.lat!=='number'||typeof b.lng!=='number'||typeof b.acc!=='number')return send(400,{error:'Location missing.'});
   if(b.acc>Math.max(15,s.radius*1.5))return send(400,{error:'GPS signal too weak (±'+Math.round(b.acc)+' m). Move near a window and try again.'});
   const m=Math.round(dist(s.lat,s.lng,b.lat,b.lng));
   if(m>s.radius)return send(400,{error:'You are '+m+' m from the class. You must be within '+s.radius+' m.'});
   if(typeof b.img!=='string'||!b.img.startsWith('data:image/jpeg;base64,')||b.img.length>200000)return send(400,{error:'Selfie missing or too large.'});
   const rec={...st,ts:Date.now(),dist:m,acc:Math.round(b.acc),device:dev};
   if(!(await cmd('HSETNX','rec:'+s.sid,id,JSON.stringify(rec))))return send(409,{error:'This ID is already registered for this class.'});
   await pipe([['HSET','dev:'+s.sid,dev,id],['SET','img:'+s.sid+':'+id,b.img]]);
   return send(200,{ok:true,name:st.name,course:s.course})}
  return send(404,{error:'Not found'});
 }catch(e){console.error(e);send(500,{error:'Server error'})}
};
