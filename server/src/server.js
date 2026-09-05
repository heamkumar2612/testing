import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const dataDir=path.resolve(__dirname,'..','data');fs.mkdirSync(dataDir,{recursive:true});
const dbFile=path.join(dataDir,'resqflow.json');
const JWT_SECRET=process.env.JWT_SECRET||'change-this-secret';
const PORT=Number(process.env.PORT||4000);

const empty=()=>({users:[],hospitals:[],emergencies:[],referrals:[],hospital_claims:[],ambulance_locations:[],ambulances:[],ambulance_access_requests:[]});
let db=fs.existsSync(dbFile)?JSON.parse(fs.readFileSync(dbFile,'utf8')):empty();
const save=()=>{fs.writeFileSync(dbFile,JSON.stringify(db,null,2),'utf8')};
const now=()=>new Date().toISOString();
const nextId=arr=>arr.length?Math.max(...arr.map(x=>Number(x.id)||0))+1:1;
const findUser=u=>db.users.find(x=>x.username.toLowerCase()===String(u||'').trim().toLowerCase());
const serializeHospital=h=>({...h,equipment:Array.isArray(h.equipment)?h.equipment:[],capabilities:Array.isArray(h.capabilities)?h.capabilities:(h.equipment||[]).map(name=>({name,source:'standard',status:'Available'}))});

db.hospital_claims=db.hospital_claims||[];db.ambulance_locations=db.ambulance_locations||[];db.ambulances=db.ambulances||[];db.ambulance_access_requests=db.ambulance_access_requests||[];
if(!db.users.length){
  db.users=[
    {id:1,username:'admin',password_hash:bcrypt.hashSync(process.env.ADMIN_PASSWORD||'admin123',10),role:'Admin',entity_id:null,created_at:now()},
    {id:2,username:'hospital',password_hash:bcrypt.hashSync(process.env.HOSPITAL_PASSWORD||'hospital123',10),role:'Hospital',entity_id:'hospital-1',created_at:now()},
    {id:3,username:'ambulance',password_hash:bcrypt.hashSync(process.env.AMBULANCE_PASSWORD||'ambulance123',10),role:'Ambulance',entity_id:'AMB-17',created_at:now()},
    {id:4,username:'user',password_hash:bcrypt.hashSync(process.env.USER_PASSWORD||'user123',10),role:'User',entity_id:null,created_at:now()}
  ];
}
if(!db.ambulances.some(a=>a.id==='AMB-17'))db.ambulances.push({id:'AMB-17',vehicle_number:'DEMO-AMB-17',crew_name:'Demo Crew',contact:'',type:'Advanced Life Support',status:'Active',created_at:now()});
if(!db.emergencies.some(x=>x.id==='EMR-2048')){
  db.emergencies.push({id:'EMR-2048',patient:'Unknown male · approx. 32 yrs',condition:'Suspected chest trauma • altered consciousness • heavy bleeding',severity:'Critical',ambulance:'AMB-17',lat:null,lon:null,status:'Active',created_at:now(),updated_at:now()});
}
save();

const app=express();app.use(cors());app.use(express.json());
const tokenFor=u=>jwt.sign({id:u.id,username:u.username,role:u.role,entityId:u.entity_id},JWT_SECRET,{expiresIn:'12h'});
function auth(req,res,next){const h=req.headers.authorization||'';if(!h.startsWith('Bearer '))return res.status(401).json({error:'Authentication required'});try{req.user=jwt.verify(h.slice(7),JWT_SECRET);next()}catch{return res.status(401).json({error:'Invalid or expired session'})}}
function role(...roles){return (req,res,next)=>roles.includes(req.user.role)?next():res.status(403).json({error:'Insufficient permissions'})}

app.get('/api/health',(req,res)=>res.json({ok:true,time:now()}));
app.post('/api/auth/login',async(req,res)=>{
  const u=findUser(req.body?.username);
  if(!u||!await bcrypt.compare(req.body?.password||'',u.password_hash))return res.status(401).json({error:'Invalid username or password'});
  res.json({token:tokenFor(u),user:{id:u.id,username:u.username,role:u.role,entityId:u.entity_id}});
});
app.get('/api/me',auth,(req,res)=>res.json({user:req.user}));

app.get('/api/hospitals',auth,(req,res)=>res.json({hospitals:db.hospitals.map(serializeHospital)}));
app.get('/api/hospitals/match',auth,(req,res)=>res.json({hospitals:db.hospitals.map(serializeHospital)}));

function capabilityStatusFor(h,name){
  const list=Array.isArray(h.capabilities)&&h.capabilities.length?h.capabilities:(Array.isArray(h.equipment)?h.equipment:[]);
  const item=list.find(c=>String(typeof c==='object'?c.name:c).trim().toLowerCase()===String(name).trim().toLowerCase());
  if(!item)return 'Unavailable';
  return String(typeof item==='object'?(item.status||'Available'):'Available');
}
function computeHospitalMatch(hospitals,required,distances,excludedIds=[]){
  const excluded=new Set((Array.isArray(excludedIds)?excludedIds:[]).map(String));
  const req=[...new Set((Array.isArray(required)?required:[]).filter(Boolean))];
  const distanceList=Array.isArray(distances)?distances:[];
  const byKey=new Map();
  for(const d of distanceList){if(d?.id)byKey.set(String(d.id),d);if(d?.osmId)byKey.set(String(d.osmId),d)}
  const candidates=distanceList.map(d=>{
    const key=String(d.id||d.osmId||'');
    const h=hospitals.find(x=>String(x.osm_id||x.id)===key)||hospitals.find(x=>String(x.osm_id||'')===String(d.osmId||''));
    const base={id:d.id||`candidate-${key}`,name:d.name||h?.name||'Hospital',location:[d.lat,d.lon],roadDistance:Number(d.roadDistance),roadDuration:Number(d.roadDuration),profileId:h?.id||null,clinicalDataAvailable:!!h};
    if(!h)return {...base,eligible:false,ineligibleReason:'Clinical hospital readiness data required',score:0,scoreBreakdown:{capability:0,capacity:0,readiness:0,staff:0,load:0,distance:0}};
    const statuses=req.map(x=>capabilityStatusFor(h,x));
    const capabilityRaw=req.length?statuses.reduce((sum,x)=>sum+(x==='Available'?1:x==='Limited'?.5:0),0)/req.length:1;
    const capability=Math.round(capabilityRaw*100);
    const beds=Number(h.available_beds??h.beds??0), icu=Number(h.available_icu??h.icu??0);
    const capacityRaw=Math.min(1,(Math.max(0,beds)/4)*.4+(Math.max(0,icu)/2)*.6);
    const capacity=Math.round(capacityRaw*100);
    const readinessRaw=h.enabled!==false&&h.status!=='Unavailable'?(h.status==='Ready'?1:h.status==='Busy'?.7:h.status==='Critical'?.35:h.status==='Limited'?.55:.45):0;
    const readiness=Math.round(readinessRaw*100);
    const staffText=String(h.staff||'').toLowerCase();
    const staffRaw=staffText==='high'?1:staffText==='medium'?.7:staffText==='low'?.4:staffText==='unknown'?.5:.5;
    const staff=Math.round(staffRaw*100);
    const loadRaw=1-Math.max(0,Math.min(100,Number(h.load)||0))/100;
    const load=Math.round(loadRaw*100);
    const distanceRaw=Number.isFinite(Number(d.roadDistance))?Math.max(0,1-Math.min(1,Number(d.roadDistance)/15000)):0;
    const distance=Math.round(distanceRaw*100);
    const score=Math.round(capability*.35+capacity*.15+readiness*.15+staff*.10+load*.10+distance*.15);
    const allUnavailable=req.length>0&&statuses.every(x=>x==='Unavailable');
    const excludedHere=excluded.has(String(d.id||''))||excluded.has(String(d.osmId||''));
    const eligible=h.enabled===true&&h.status!=='Unavailable'&&!allUnavailable&&!excludedHere;
    let ineligibleReason=null;
    if(h.enabled!==true)ineligibleReason='Emergency referrals disabled';
    else if(h.status==='Unavailable')ineligibleReason='Hospital unavailable';
    else if(allUnavailable)ineligibleReason='All required capabilities unavailable';
    else if(excludedHere)ineligibleReason='Temporarily excluded after hospital status change';
    return {...base,profileId:h.id,clinicalDataAvailable:true,eligible,ineligibleReason,score,scoreBreakdown:{capability,capacity,readiness,staff,load,distance},capabilityStatuses:Object.fromEntries(req.map((x,i)=>[x,statuses[i]])),status:h.status,enabled:h.enabled};
  });
  const eligible=candidates.filter(x=>x.eligible).sort((a,b)=>b.score-a.score);
  return {candidates:candidates.sort((a,b)=>b.score-a.score),eligible,best:eligible[0]||null,clinicalAvailable:candidates.some(x=>x.clinicalDataAvailable)};
}
app.post('/api/hospitals/match',auth,role('Ambulance','Admin','Hospital','User'),(req,res)=>{
  const x=req.body||{};
  res.json(computeHospitalMatch(db.hospitals,x.required,x.distances,x.excludedIds));
});
app.get('/api/hospitals/mine',auth,role('Hospital','Admin'),(req,res)=>{
  const h=req.user.role==='Hospital'?db.hospitals.find(x=>x.owner_entity_id===req.user.entityId):null;
  res.json({hospital:h?serializeHospital(h):null});
});
app.put('/api/hospitals/:id/profile',auth,role('Hospital','Admin'),(req,res)=>{
  const p=req.body||{};
  let h=db.hospitals.find(x=>x.id===Number(req.params.id)||x.osm_id===req.params.id||x.owner_entity_id===req.user.entityId);
  const t=now();
  if(!h){
    h={id:nextId(db.hospitals),owner_entity_id:req.user.entityId||null,osm_id:p.osmId||null,name:p.name||'Hospital',lat:p.lat??null,lon:p.lon??null,enabled:p.enabled!==false,status:p.status||'Ready',beds:Number(p.beds)||0,icu:Number(p.icu)||0,staff:p.staff||'Unknown',load:Math.max(0,Math.min(100,Number(p.load)||0)),equipment:Array.isArray(p.equipment)?p.equipment:[],capabilities:Array.isArray(p.capabilities)?p.capabilities:[],updated_at:t};
    db.hospitals.push(h);
  }else{
    Object.assign(h,{owner_entity_id:h.owner_entity_id||req.user.entityId||null,osm_id:p.osmId??h.osm_id,name:p.name??h.name,lat:p.lat??h.lat,lon:p.lon??h.lon,enabled:p.enabled!==false,status:p.status||h.status,beds:Math.max(0,Number(p.beds??h.beds)),icu:Math.max(0,Number(p.icu??h.icu)),staff:p.staff||h.staff,load:Math.max(0,Math.min(100,Number(p.load??h.load))),equipment:Array.isArray(p.equipment)?p.equipment:h.equipment,capabilities:Array.isArray(p.capabilities)?p.capabilities:(h.capabilities||[]),updated_at:t});
  }
  save();res.json({hospital:serializeHospital(h)});
});


app.post('/api/hospitals/register',auth,role('Admin'),(req,res)=>{const x=req.body||{};if(!x.name)return res.status(400).json({error:'Hospital name required'});if(x.osmId&&db.hospitals.some(h=>h.osm_id===x.osmId))return res.status(409).json({error:'Hospital already registered'});const h={id:nextId(db.hospitals),owner_entity_id:null,osm_id:x.osmId||null,name:x.name,lat:x.lat??null,lon:x.lon??null,enabled:true,status:'Ready',beds:0,icu:0,staff:'Unknown',load:0,equipment:[],capabilities:[],updated_at:now()};db.hospitals.push(h);const raw=Math.random().toString(36).slice(2,8).toUpperCase();db.hospital_claims.push({id:nextId(db.hospital_claims),hospital_id:h.id,name:h.name,osm_id:h.osm_id,status:'Activation Pending',activation_code_hash:bcrypt.hashSync(raw,10),created_at:now()});save();res.status(201).json({hospital:serializeHospital(h),activationCode:raw});});
app.post('/api/hospitals/claim',auth,role('Ambulance','Admin'),(req,res)=>{const x=req.body||{};if(!x.osmId||!x.name)return res.status(400).json({error:'Hospital name and OSM ID required'});if(db.hospitals.some(h=>h.osm_id===x.osmId))return res.status(409).json({error:'Hospital already registered'});if(db.hospital_claims.some(c=>c.osm_id===x.osmId&&c.status==='Pending'))return res.status(409).json({error:'Claim already pending'});const c={id:nextId(db.hospital_claims),hospital_id:null,name:x.name,osm_id:x.osmId,status:'Pending',requested_by:req.user.entityId||req.user.username,created_at:now()};db.hospital_claims.push(c);save();res.status(201).json({claim:c});});
app.get('/api/hospitals/claims',auth,role('Admin'),(req,res)=>res.json({claims:[...db.hospital_claims].reverse()}));
app.get('/api/ambulances/approaching',auth,role('Hospital'),(req,res)=>{const h=db.hospitals.find(x=>x.owner_entity_id===req.user.entityId);if(!h)return res.json({ambulances:[]});const list=db.ambulance_locations.filter(a=>a.destination_hospital_id===h.id).map(a=>{const e=db.emergencies.find(x=>x.id===a.emergency_id);return {...a,emergency:e||null}});res.json({ambulances:list})});
app.patch('/api/ambulances/:id/location',auth,role('Ambulance','Admin'),(req,res)=>{const x=req.body||{};if(typeof x.lat!=='number'||typeof x.lon!=='number')return res.status(400).json({error:'lat and lon required'});let a=db.ambulance_locations.find(x=>x.id===req.params.id);if(!a){a={id:req.params.id,ambulance_id:req.params.id};db.ambulance_locations.push(a)}Object.assign(a,{lat:x.lat,lon:x.lon,emergency_id:x.emergencyId||a.emergency_id||'EMR-2048',destination_hospital_id:x.destinationHospitalId??a.destination_hospital_id??null,eta_minutes:x.etaMinutes??a.eta_minutes??null,distance_km:x.distanceKm??a.distance_km??null,updated_at:now()});save();res.json({location:a})});

app.post('/api/ambulances/access-requests',(req,res)=>{const x=req.body||{};if(!x.ambulanceId||!x.crewName||!x.contact)return res.status(400).json({error:'Ambulance ID, crew name and contact are required'});if(db.users.some(u=>u.entity_id===x.ambulanceId)||db.ambulances.some(a=>a.id===x.ambulanceId))return res.status(409).json({error:'Ambulance already registered'});if(db.ambulance_access_requests.some(r=>r.ambulance_id===x.ambulanceId&&r.status==='Pending'))return res.status(409).json({error:'Access request already pending'});const r={id:nextId(db.ambulance_access_requests),ambulance_id:x.ambulanceId,vehicle_number:x.vehicleNumber||'',crew_name:x.crewName,contact:x.contact,type:x.type||'Basic Ambulance',status:'Pending',created_at:now()};db.ambulance_access_requests.push(r);save();res.status(201).json({request:r});});
app.get('/api/ambulances/access-requests',auth,role('Admin'),(req,res)=>res.json({requests:[...db.ambulance_access_requests].reverse()}));
app.post('/api/ambulances/register',auth,role('Admin'),(req,res)=>{const x=req.body||{};if(!x.ambulanceId||!x.crewName)return res.status(400).json({error:'Ambulance ID and crew name required'});if(db.users.some(u=>u.entity_id===x.ambulanceId)||db.ambulances.some(a=>a.id===x.ambulanceId))return res.status(409).json({error:'Ambulance already registered'});const a={id:x.ambulanceId,vehicle_number:x.vehicleNumber||'',crew_name:x.crewName,contact:x.contact||'',type:x.type||'Basic Ambulance',status:'Active',created_at:now()};db.ambulances.push(a);const raw=Math.random().toString(36).slice(2,8).toUpperCase();db.ambulance_access_requests.push({id:nextId(db.ambulance_access_requests),ambulance_id:a.id,vehicle_number:a.vehicle_number,crew_name:a.crew_name,contact:a.contact,type:a.type,status:'Activation Pending',activation_code_hash:bcrypt.hashSync(raw,10),created_at:now()});save();res.status(201).json({ambulance:a,activationCode:raw});});
app.post('/api/ambulances/access-requests/:id/approve',auth,role('Admin'),(req,res)=>{const r=db.ambulance_access_requests.find(x=>x.id===Number(req.params.id));if(!r)return res.status(404).json({error:'Access request not found'});if(r.status!=='Pending')return res.status(409).json({error:'Request is not pending'});if(db.users.some(u=>u.entity_id===r.ambulance_id))return res.status(409).json({error:'Ambulance already has an account'});const a={id:r.ambulance_id,vehicle_number:r.vehicle_number,crew_name:r.crew_name,contact:r.contact,type:r.type,status:'Active',created_at:now()};db.ambulances.push(a);const raw=Math.random().toString(36).slice(2,8).toUpperCase();r.status='Activation Pending';r.activation_code_hash=bcrypt.hashSync(raw,10);r.approved_at=now();save();res.json({request:r,ambulance:a,activationCode:raw});});
app.post('/api/ambulances/activate',(req,res)=>{const x=req.body||{};const r=db.ambulance_access_requests.find(q=>q.status==='Activation Pending'&&q.activation_code_hash&&bcrypt.compareSync(String(x.activationCode||''),q.activation_code_hash));if(!r)return res.status(400).json({error:'Invalid or expired activation code'});if(!x.username||!x.password||String(x.password).length<6)return res.status(400).json({error:'Username and password (minimum 6 characters) are required'});if(findUser(x.username))return res.status(409).json({error:'Username already exists'});const u={id:nextId(db.users),username:String(x.username).trim(),password_hash:bcrypt.hashSync(x.password,10),role:'Ambulance',entity_id:r.ambulance_id,created_at:now()};db.users.push(u);r.status='Activated';r.used_at=now();r.activation_code_hash=null;save();res.status(201).json({token:tokenFor(u),user:{id:u.id,username:u.username,role:u.role,entityId:u.entity_id}});});
app.get('/api/ambulances',auth,role('Admin'),(req,res)=>res.json({ambulances:db.ambulances}));

const SYMPTOM_PROFILES=[
 {name:'Acute coronary syndrome / possible heart attack',keys:['chest pain','chest pressure','chest tightness','pain in chest','left arm pain','jaw pain','shortness of breath','sweating','dizziness'],required:['Emergency','Cardiology','ICU','Cath Lab'],severity:'CRITICAL'},
 {name:'Major trauma / internal bleeding',keys:['heavy bleeding','severe bleeding','bleeding','road accident','crash','trauma','unconscious','loss of consciousness','altered consciousness','head injury','chest injury'],required:['Emergency','Trauma','ICU','Blood Bank','CT'],severity:'CRITICAL'},
 {name:'Possible stroke',keys:['face drooping','facial droop','arm weakness','speech difficulty','slurred speech','unable to speak','sudden weakness','sudden numbness','stroke'],required:['Emergency','Neurology','CT','ICU'],severity:'CRITICAL'},
 {name:'Severe respiratory distress',keys:['difficulty breathing','breathing difficulty','shortness of breath','cannot breathe','wheezing','blue lips','low oxygen','breathless'],required:['Emergency','Pulmonology','ICU','Ventilator Support'],severity:'HIGH'},
 {name:'Possible poisoning / toxic exposure',keys:['poison','poisoning','overdose','toxic','chemical exposure','swallowed chemical','drug overdose'],required:['Emergency','ICU'],severity:'HIGH'},
 {name:'Possible severe infection / sepsis',keys:['high fever','fever','chills','confusion','rapid breathing','fast heart rate','infection','very weak'],required:['Emergency','ICU','Blood Bank'],severity:'HIGH'},
 {name:'Possible fracture / orthopedic injury',keys:['broken bone','fracture','deformed arm','deformed leg','severe limb pain','swollen ankle','unable to walk'],required:['Emergency','Orthopedics','X-Ray','CT'],severity:'HIGH'}
];

// Tamil clinical phrases are normalized into the same English symptom vocabulary
// so typed Tamil, Tamil speech-to-text, mixed Tamil-English, and English all use
// the same triage and hospital-matching logic. This is decision support, not diagnosis.
const TAMIL_SYMPTOM_MAP=[
 ['மார்பு வலி','chest pain'],['நெஞ்சு வலி','chest pain'],['நெஞ்சில் வலி','chest pain'],['மார்பில் வலி','chest pain'],
 ['மூச்சு விட கஷ்டமா இருக்கு','difficulty breathing'],['மூச்சு விட கஷ்டம்','difficulty breathing'],['மூச்சு விட சிரமமா இருக்கு','difficulty breathing'],['மூச்சு விட சிரமம்','difficulty breathing'],['மூச்சுத்திணறல்','difficulty breathing'],['மூச்சு திணறல்','difficulty breathing'],['மூச்சு வாங்குகிறது','difficulty breathing'],['மூச்சு வாங்குது','difficulty breathing'],
 ['அதிகமாக வியர்க்குது','sweating'],['அதிகமாக வியர்க்கிறது','sweating'],['அதிகமாக வியர்வை','sweating'],['வியர்க்குது','sweating'],['வியர்க்கிறது','sweating'],['வியர்வை','sweating'],['அதிக வியர்வை','sweating'],['தலைச்சுற்றல்','dizziness'],['தலை சுற்றல்','dizziness'],['இடது கை வலி','left arm pain'],['தாடை வலி','jaw pain'],
 ['அதிக ரத்தப்போக்கு','heavy bleeding'],['கடுமையான ரத்தப்போக்கு','heavy bleeding'],['ரத்தம் அதிகமாக போகிறது','heavy bleeding'],['ரத்தப்போக்கு','bleeding'],['சாலை விபத்து','road accident'],['விபத்து','road accident'],['மயக்கம்','unconscious'],['மயங்கி','unconscious'],['நினைவு இல்லை','loss of consciousness'],['நினைவிழப்பு','loss of consciousness'],['நினைவு இழந்த','loss of consciousness'],['தலையில் காயம்','head injury'],['மார்பில் காயம்','chest injury'],
 ['முகம் சாய்வு','face drooping'],['முகம் வளைந்து','face drooping'],['கை பலவீனம்','arm weakness'],['கையில் பலவீனம்','arm weakness'],['பேச முடியவில்லை','unable to speak'],['பேச்சு தெளிவாக இல்லை','slurred speech'],['திடீர் பலவீனம்','sudden weakness'],['திடீர் உணர்வின்மை','sudden numbness'],
 ['வீசிங்','wheezing'],['மூச்சு வரவில்லை','cannot breathe'],['உதடு நீலமாக','blue lips'],['ஆக்சிஜன் குறைவு','low oxygen'],['ஆக்சிஜன் குறைவாக','low oxygen'],
 ['விஷம்','poison'],['விஷம் குடித்த','poisoning'],['விஷம் குடித்துள்ளார்','poisoning'],['நச்சு','toxic'],['ரசாயன பாதிப்பு','chemical exposure'],['மருந்து அதிகமாக','drug overdose'],['மருந்தை அதிகமாக எடுத்த','drug overdose'],
 ['அதிக காய்ச்சல்','high fever'],['காய்ச்சல்','fever'],['நடுக்கம்','chills'],['குழப்பம்','confusion'],['வேகமாக மூச்சு','rapid breathing'],['இதயத் துடிப்பு வேகம்','fast heart rate'],['இதய துடிப்பு வேகம்','fast heart rate'],['தொற்று','infection'],['மிகவும் பலவீனம்','very weak'],
 ['எலும்பு முறிவு','fracture'],['எலும்பு உடைந்த','broken bone'],['கை வளைந்துள்ளது','deformed arm'],['கால் வளைந்துள்ளது','deformed leg'],['கையில் கடும் வலி','severe limb pain'],['காலில் கடும் வலி','severe limb pain'],['கணுக்கால் வீக்கம்','swollen ankle'],['நடக்க முடியவில்லை','unable to walk']
];
function normalizeSymptoms(input){
  let text=String(input||'').normalize('NFKC').toLowerCase();
  // Tamil spoken/typed normalization. Keep this broad because browser speech-to-text
  // can produce inflected or slightly different colloquial forms.
  const rules=[
    // Broad speech-to-text tolerant rules: Tamil ASR may change endings, insert
    // particles such as 'லும்', or render colloquial forms like வேர்க்குது.
    [/மூச்சு[^\n\r,.;!?]{0,28}(?:கஷ்ட|சிரம|திணற|முடியல|முடியவில்லை|வரல|வரவில்லை)/gu,' difficulty breathing '],
    [/மூச்சு\s*(?:விட|விடுவதில்|விடுற|விடற)?\s*(?:கஷ்ட|சிரம)(?:மா|மாக)?(?:\s*(?:இருக்கு|இருக்க|இருக்கிறது|இருக்குது|இருக்குனு|உள்ளது))?/gu,' difficulty breathing '],
    [/மூச்சு\s*(?:திணறல்|திணறுது|திணறுகிறது|திணறுத|திணறல்|வாங்குது|வாங்குகிறது|வாங்குத|வரல|வரவில்லை|வரலையா)/gu,' difficulty breathing '],
    [/மூச்சு\s*(?:விட|எடுக்க)\s*(?:முடியல|முடியவில்லை|கஷ்டம்|சிரமம்|சிரமமா|கஷ்டமா)/gu,' difficulty breathing '],
    [/(?:மூச்சு\s*திணறல்|மூச்சுத்திணறல்)/gu,' difficulty breathing '],
    [/(?:வியர்வை|வியர்க்கு|வியர்க்குது|வியர்க்கிறது|வியர்த்தல்|வியர்க்கிற|வியர்வையாக|வேர்க்குது|வேர்க்கிறது|வேர்க்கிற|வேர்வை)/gu,' sweating '],
    [/(?:தலை\s*சுற்றல்|தலைசுற்றல்|தலைச்சுற்றல்|தலை\s*சுற்றுது|தலை\s*சுற்றுகிறது|தலைச்சுற்றுது|தலைச்சுற்றுகிறது|தலை\s*சுத்துது|தலைசுத்தல்|தலைச்சுற்ற)/gu,' dizziness '],
    [/(?:நெஞ்சில்|நெஞ்சு|மார்பில்|மார்பு)\s*வலி/gu,' chest pain '],
    [/(?:இடது\s*கை|கை)\s*வலி/gu,' left arm pain '],
    [/(?:தாடை)\s*வலி/gu,' jaw pain '],
    [/(?:அதிக\s*ரத்தப்போக்கு|கடுமையான\s*ரத்தப்போக்கு|ரத்தம்\s*அதிகமாக\s*போகிறது|ரத்தப்போக்கு)/gu,' bleeding '],
    [/(?:சாலை\s*விபத்து|விபத்து)/gu,' road accident '],
    [/(?:மயக்கம்|மயங்கி|நினைவு\s*இல்லை|நினைவிழப்பு|நினைவு\s*இழந்த)/gu,' unconscious '],
    [/(?:தலையில்\s*காயம்)/gu,' head injury '],
    [/(?:முகம்\s*சாய்வு|முகம்\s*வளைந்து)/gu,' face drooping '],
    [/(?:கை\s*பலவீனம்|கையில்\s*பலவீனம்)/gu,' arm weakness '],
    [/(?:பேச\s*முடியவில்லை)/gu,' unable to speak '],
    [/(?:பேச்சு\s*தெளிவாக\s*இல்லை)/gu,' slurred speech '],
    [/(?:திடீர்\s*பலவீனம்)/gu,' sudden weakness '],
    [/(?:திடீர்\s*உணர்வின்மை)/gu,' sudden numbness '],
    [/(?:மூச்சு\s*வரவில்லை)/gu,' cannot breathe '],
    [/(?:உதடு\s*நீலமாக)/gu,' blue lips '],
    [/(?:ஆக்சிஜன்\s*குறைவு|ஆக்சிஜன்\s*குறைவாக)/gu,' low oxygen '],
    [/(?:விஷம்\s*குடித்துள்ளார்|விஷம்\s*குடித்த|விஷம்)/gu,' poisoning '],
    [/(?:நச்சு|ரசாயன\s*பாதிப்பு)/gu,' toxic exposure '],
    [/(?:மருந்தை\s*அதிகமாக\s*எடுத்த|மருந்து\s*அதிகமாக)/gu,' drug overdose '],
    [/(?:அதிக\s*காய்ச்சல்)/gu,' high fever '],
    [/(?:காய்ச்சல்)/gu,' fever '],
    [/(?:நடுக்கம்)/gu,' chills '],
    [/(?:குழப்பம்)/gu,' confusion '],
    [/(?:வேகமாக\s*மூச்சு)/gu,' rapid breathing '],
    [/(?:இதய[த்\s]*துடிப்பு\s*வேகம்)/gu,' fast heart rate '],
    [/(?:தொற்று)/gu,' infection '],
    [/(?:மிகவும்\s*பலவீனம்)/gu,' very weak ']
  ];
  for(const [re,replacement] of rules) text=text.replace(re,replacement);
  // Dictionary pass catches exact phrases and alternate spellings not covered above.
  for(const [ta,en] of TAMIL_SYMPTOM_MAP) text=text.split(ta).join(` ${en} `);
  return text.replace(/[^\p{L}\p{N}\s-]/gu,' ').replace(/\s+/g,' ').trim();
}
function extractDeterministicSymptoms(input){
  const raw=String(input||'').normalize('NFKC').toLowerCase();
  const found=new Set();
  const add=(sym)=>found.add(sym);
  // English
  const en=[
    ['chest pain',['chest pain','chest pressure','chest tightness','pain in chest']],
    ['difficulty breathing',['difficulty breathing','breathing difficulty','shortness of breath','cannot breathe','breathless','hard to breathe']],
    ['sweating',['sweating','sweaty','heavy sweating','excessive sweating']],
    ['dizziness',['dizziness','dizzy','lightheaded']],
    ['left arm pain',['left arm pain']],['jaw pain',['jaw pain']],
    ['heavy bleeding',['heavy bleeding','severe bleeding']],['bleeding',['bleeding']],
    ['road accident',['road accident','crash','accident','trauma']],['unconscious',['unconscious','loss of consciousness']],
    ['head injury',['head injury']],['chest injury',['chest injury']],['face drooping',['face drooping','facial droop']],
    ['arm weakness',['arm weakness']],['unable to speak',['unable to speak']],['slurred speech',['slurred speech']],
    ['sudden weakness',['sudden weakness']],['sudden numbness',['sudden numbness']],['wheezing',['wheezing']],
    ['cannot breathe',['cannot breathe']],['blue lips',['blue lips']],['low oxygen',['low oxygen']],
    ['poisoning',['poison','poisoning','overdose']],['toxic exposure',['toxic','chemical exposure']],
    ['drug overdose',['drug overdose']],['high fever',['high fever']],['fever',['fever']],['chills',['chills']],
    ['confusion',['confusion']],['rapid breathing',['rapid breathing']],['fast heart rate',['fast heart rate']],
    ['infection',['infection']],['very weak',['very weak']],['fracture',['fracture','broken bone']],['severe limb pain',['severe limb pain']],
    ['swollen ankle',['swollen ankle']],['unable to walk',['unable to walk']]
  ];
  for(const [sym,alts] of en) if(alts.some(a=>raw.includes(a))) add(sym);
  // Tamil: deliberately use semantic stems/combination rules so browser ASR inflections do not break extraction.
  const has=(...parts)=>parts.every(x=>raw.includes(x));
  if(raw.includes('நெஞ்சு')&&raw.includes('வலி') || raw.includes('மார்பு')&&raw.includes('வலி') || raw.includes('மார்பில்')&&raw.includes('வலி')) add('chest pain');
  if(raw.includes('மூச்சு') && ['கஷ்ட','சிரம','திணற','முடிய','வரல','வாங்க'].some(x=>raw.includes(x))) add('difficulty breathing');
  if(raw.includes('மூச்சுத்திணறல்') || raw.includes('மூச்சு திணறல்')) add('difficulty breathing');
  if(raw.includes('வியர') || raw.includes('வேர்க்க') || raw.includes('வியர்வ')) add('sweating');
  if(raw.includes('தலை') && (raw.includes('சுற்ற') || raw.includes('சுத்த'))) add('dizziness');
  if(raw.includes('இடது')&&raw.includes('கை')&&raw.includes('வலி')) add('left arm pain');
  if(raw.includes('தாடை')&&raw.includes('வலி')) add('jaw pain');
  if(raw.includes('ரத்தப்போக்கு') || (raw.includes('ரத்தம்')&&raw.includes('போகிறது'))) add('bleeding');
  if(raw.includes('சாலை விபத்து')||raw.includes('விபத்து')) add('road accident');
  if(raw.includes('மயக்கம்')||raw.includes('மயங்கி')||raw.includes('நினைவு இல்லை')||raw.includes('நினைவிழப்பு')||raw.includes('நினைவு இழந்த')) add('unconscious');
  if(raw.includes('தலையில்')&&raw.includes('காயம்')) add('head injury');
  if(raw.includes('முகம்')&&(raw.includes('சாய்வு')||raw.includes('வளைந்து'))) add('face drooping');
  if(raw.includes('கை')&&raw.includes('பலவீனம்')) add('arm weakness');
  if(raw.includes('பேச')&&raw.includes('முடியவில்லை')) add('unable to speak');
  if(raw.includes('பேச்சு')&&raw.includes('தெளிவாக')&&raw.includes('இல்லை')) add('slurred speech');
  if(raw.includes('திடீர்')&&raw.includes('பலவீனம்')) add('sudden weakness');
  if(raw.includes('திடீர்')&&raw.includes('உணர்வின்மை')) add('sudden numbness');
  if(raw.includes('வீசிங்')) add('wheezing');
  if(raw.includes('மூச்சு')&&raw.includes('வரவில்லை')) add('cannot breathe');
  if(raw.includes('உதடு')&&raw.includes('நீல')) add('blue lips');
  if(raw.includes('ஆக்சிஜன்')&&raw.includes('குறை')) add('low oxygen');
  if(raw.includes('விஷம்')) add('poisoning');
  if(raw.includes('நச்சு')||raw.includes('ரசாயன')) add('toxic exposure');
  if(raw.includes('மருந்த')&&raw.includes('அதிக')) add('drug overdose');
  if(raw.includes('அதிக காய்ச்சல்')) add('high fever');
  else if(raw.includes('காய்ச்சல்')) add('fever');
  if(raw.includes('நடுக்கம்')) add('chills');
  if(raw.includes('குழப்பம்')) add('confusion');
  if(raw.includes('வேகமாக')&&raw.includes('மூச்சு')) add('rapid breathing');
  if(raw.includes('இதய')&&raw.includes('துடிப்பு')&&raw.includes('வேகம்')) add('fast heart rate');
  if(raw.includes('தொற்று')) add('infection');
  if(raw.includes('மிகவும்')&&raw.includes('பலவீனம்')) add('very weak');
  if(raw.includes('எலும்பு')&&(raw.includes('முறிவு')||raw.includes('உடைந்த'))) add('fracture');
  if(raw.includes('கடுமையான')&&raw.includes('வலி')&&(raw.includes('கை')||raw.includes('கால்'))) add('severe limb pain');
  if(raw.includes('கணுக்கால்')&&raw.includes('வீக்கம்')) add('swollen ankle');
  if(raw.includes('நடக்க')&&raw.includes('முடியவில்லை')) add('unable to walk');
  return [...found];
}

function analyzeSymptoms(input){
 const normalized=normalizeSymptoms(input);
 const directHits=extractDeterministicSymptoms(input);
 const scores=SYMPTOM_PROFILES.map(p=>{const hits=p.keys.filter(k=>normalized.includes(k));return {...p,hits,score:hits.length}}).sort((a,b)=>b.score-a.score); const top=scores[0];
 if(directHits.length){ const hitProfiles=SYMPTOM_PROFILES.map(p=>({...p,hits:p.keys.filter(k=>directHits.includes(k))})).filter(p=>p.hits.length); const best=hitProfiles.sort((a,b)=>b.hits.length-a.hits.length)[0]||top; const confidence=Math.min(97,68+directHits.length*7+(directHits.length>=3?5:0)); return {severity:best?.severity||'HIGH',confidence,suspected:best?.name||'Undifferentiated medical emergency',required:[...new Set(['Emergency',...(hitProfiles.flatMap(p=>p.required))])],reason:`Detected ${directHits.length} symptom signal${directHits.length===1?'':'s'}: ${directHits.join(', ')}. This is multilingual decision support, not a diagnosis; confirm clinically and route according to current hospital capability and readiness.`,symptoms:input,normalizedSymptoms:[...new Set([...directHits,...normalized.split(' ')])].slice(0,30),matchedSymptoms:directHits,language:detectSymptomLanguage(input)};}
 if(!top||top.score===0)return {severity:'MODERATE',confidence:58,suspected:'Undifferentiated medical emergency',required:['Emergency'],reason:'The symptoms do not strongly match one predefined emergency pattern. A clinician should assess the patient promptly and the ambulance should remain ready for escalation.',symptoms:input,normalizedSymptoms:normalized,matchedSymptoms:[],language:detectSymptomLanguage(input)};
 const confidence=Math.min(97,68+top.score*7+(top.score>=3?5:0));
 return {severity:top.severity,confidence,suspected:top.name,required:top.required,reason:`Detected ${top.hits.length} matching symptom signal${top.hits.length===1?'':'s'}: ${top.hits.join(', ')}. This is multilingual decision support, not a diagnosis; confirm clinically and route according to current hospital capability and readiness.`,symptoms:input,normalizedSymptoms:normalized,matchedSymptoms:top.hits,language:detectSymptomLanguage(input)};
}
function detectSymptomLanguage(input){return /[\u0B80-\u0BFF]/.test(String(input||''))?'Tamil':'English / mixed';}

const OLLAMA_URL=process.env.OLLAMA_URL||'http://127.0.0.1:11434/api/chat';
const OLLAMA_MODEL=process.env.OLLAMA_MODEL||'qwen3:8b';
const ALLOWED_CAPABILITIES=['Emergency','Trauma','ICU','Blood Bank','Ventilator Support','Cardiology','Neurology','Nephrology','Gastroenterology','Pulmonology','Oncology','Pediatrics','Obstetrics & Gynecology','Orthopedics','Psychiatry','Cath Lab','OT','CT','MRI','X-Ray','Ultrasound','Dialysis','Burns Unit','Blood Transfusion','Poison Control','Neurosurgery','Pediatric ICU','Stroke Unit'];
function extractJson(text){const clean=String(text||'').replace(/```json|```/g,'').trim();const a=clean.indexOf('{'),b=clean.lastIndexOf('}');if(a<0||b<=a)throw new Error('LLM did not return JSON');return JSON.parse(clean.slice(a,b+1));}
function validateLlmAnalysis(raw,symptoms){
 const llmSeverity=['CRITICAL','HIGH','MODERATE','LOW'].includes(String(raw?.severity||'').toUpperCase())?String(raw.severity).toUpperCase():'MODERATE';
 const normalized=normalizeSymptoms(symptoms);
 // Deterministically extract every symptom signal we can recognize, then merge it
 // with the LLM extraction. This prevents the LLM from silently dropping a symptom
 // (especially Tamil morphology/colloquial speech) before hospital matching.
 const detectedProfiles=SYMPTOM_PROFILES.map(p=>({...p,hits:p.keys.filter(k=>normalized.includes(k))})).filter(p=>p.hits.length>0);
 const deterministicHits=[...new Set([...extractDeterministicSymptoms(symptoms),...detectedProfiles.flatMap(p=>p.hits)])];
 const llmHits=Array.isArray(raw?.matchedSymptoms)?raw.matchedSymptoms.map(String).filter(Boolean):[];
 const matchedSymptoms=[...new Set([...deterministicHits,...llmHits])].slice(0,20);
 const deterministicRequired=detectedProfiles.flatMap(p=>p.required);
 const llmRequired=Array.isArray(raw?.required)?raw.required.filter(x=>ALLOWED_CAPABILITIES.includes(x)):[ ];
 const required=[...new Set(['Emergency',...deterministicRequired,...llmRequired])];
 const severityRank={LOW:1,MODERATE:2,HIGH:3,CRITICAL:4};
 const deterministicSeverity=detectedProfiles.reduce((best,p)=>severityRank[p.severity]>severityRank[best]?p.severity:best,'LOW');
 const severity=severityRank[deterministicSeverity]>severityRank[llmSeverity]?deterministicSeverity:llmSeverity;
 const confidenceBase=Math.max(0,Math.min(95,Number(raw?.confidence)||60));
 const confidence=deterministicHits.length>=3?Math.max(confidenceBase,88):deterministicHits.length===2?Math.max(confidenceBase,82):confidenceBase;
 const suspected=String(raw?.suspected||detectedProfiles[0]?.name||'Undifferentiated medical emergency');
 const reason=deterministicHits.length>0
   ?`Detected ${matchedSymptoms.length} symptom signal${matchedSymptoms.length===1?'':'s'}: ${matchedSymptoms.join(', ')}. ${String(raw?.reason||'')} This is multilingual decision support, not a diagnosis; confirm clinically and route according to current hospital capability and readiness.`.replace(/\s+/g,' ').trim()
   :'Local multilingual LLM decision support. This is not a diagnosis; confirm clinically and route according to current hospital capability and readiness.';
 return {severity,confidence,suspected,required,reason,symptoms,normalizedSymptoms:[...new Set([...(Array.isArray(raw?.normalizedSymptoms)?raw.normalizedSymptoms.map(String):[]),...deterministicHits])].slice(0,20),matchedSymptoms,language:detectSymptomLanguage(symptoms)};
}
async function analyzeWithLocalLLM(symptoms){
 const system=`You are the ResQFlow emergency triage extraction model. Understand English, Tamil, and Tamil-English mixed speech/text. Translate/normalize the COMPLETE symptom description before deciding. NEVER ignore a symptom merely because it is colloquial or expressed with Tamil inflections such as -மா இருக்கு, -குது, -கிறது, or spoken variants. Extract EVERY clinically relevant symptom mentioned. Do NOT claim a definitive diagnosis. Return ONLY valid JSON with keys: severity (CRITICAL|HIGH|MODERATE|LOW), confidence (0-95), suspected (short possible emergency condition), normalizedSymptoms (array containing EVERY symptom as short English clinical terms), matchedSymptoms (array containing EVERY important symptom signal), required (array using only these exact capability names: ${ALLOWED_CAPABILITIES.join(', ')}), reason (one short explanation). Prioritize emergency red flags and combinations of symptoms. Use clinical decision support, not treatment advice. Example: Tamil 'நெஞ்சு வலி இருக்கு, மூச்சு விட கஷ்டமா இருக்கு, அதிகமாக வியர்க்குது' must yield normalizedSymptoms including chest pain, difficulty breathing, and sweating, and required capabilities including Emergency, Cardiology, ICU, and Cath Lab.`;
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),12000);
 try{const r=await fetch(OLLAMA_URL,{method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,body:JSON.stringify({model:OLLAMA_MODEL,stream:false,format:'json',options:{temperature:0.1},messages:[{role:'system',content:system},{role:'user',content:`Patient/driver symptom description: ${symptoms}`} ]})});if(!r.ok)throw new Error(`Ollama HTTP ${r.status}`);const data=await r.json();return validateLlmAnalysis(extractJson(data?.message?.content),symptoms);}finally{clearTimeout(timer)}}
app.post('/api/ai/triage',auth,role('Ambulance','Admin','User'),async(req,res)=>{const symptoms=String(req.body?.symptoms||'').trim();if(!symptoms)return res.status(400).json({error:'Symptoms are required'});let analysis,engine='Qwen3 8B local LLM (Ollama)';try{analysis=await analyzeWithLocalLLM(symptoms);}catch(err){analysis=analyzeSymptoms(symptoms);engine='ResQFlow multilingual safety fallback (rule engine)';}res.json({analysis,engine,model:engine.includes('Qwen3')?OLLAMA_MODEL:null,timestamp:now()});});

app.get('/api/emergencies',auth,(req,res)=>res.json({emergencies:db.emergencies}));
app.post('/api/emergencies',auth,role('User','Ambulance','Admin'),(req,res)=>{
  const x=req.body||{}, id=x.id||`EMR-${Date.now()}`, t=now();
  if(db.emergencies.some(e=>e.id===id))return res.status(409).json({error:'Emergency already exists'});
  db.emergencies.push({id,patient:x.patient||'Unknown patient',condition:x.condition||'',severity:x.severity||'Moderate',ambulance:x.ambulance||null,lat:x.lat??null,lon:x.lon??null,status:'Active',created_at:t,updated_at:t});
  save();res.status(201).json({id});
});
app.patch('/api/emergencies/:id',auth,(req,res)=>{
  const e=db.emergencies.find(x=>x.id===req.params.id);if(!e)return res.status(404).json({error:'Emergency not found'});
  Object.assign(e,req.body||{}, {updated_at:now(),id:e.id});save();res.json({emergency:e});
});

app.get('/api/referrals',auth,(req,res)=>res.json({referrals:[...db.referrals].reverse()}));
app.post('/api/referrals',auth,(req,res)=>{
  const x=req.body||{}, r={id:nextId(db.referrals),emergency_id:x.emergencyId||'EMR-2048',from_hospital:x.fromHospital||'',to_hospital:x.toHospital||'',reason:x.reason||'Hospital status changed',created_at:now()};
  db.referrals.push(r);save();res.status(201).json(r);
});

app.listen(PORT,()=>console.log(`ResQFlow API running on http://localhost:${PORT}`));
