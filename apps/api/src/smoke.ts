/**
 * Destructive write-oriented smoke test for a disposable local development database ONLY.
 * Requires STARMED_TEST_DB=true and STARMED_SMOKE_ADMIN_EMAIL/PASSWORD.
 * Start the API before running; never point at an environment with patient data.
 */
import { randomUUID } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { config } from 'dotenv';
import { resolve } from 'node:path';
config({path:resolve(process.cwd(),'../../.env')});
config({path:resolve(process.cwd(),'.env')});

if(process.env.STARMED_TEST_DB!=='true')throw new Error('Set STARMED_TEST_DB=true only for a disposable local database');
const apiBase=new URL(process.env.STARMED_SMOKE_API_URL||'http://127.0.0.1:3001');
if(!['localhost','127.0.0.1','::1','[::1]'].includes(apiBase.hostname))
  throw new Error('Smoke tests are restricted to loopback API hosts');
const adminEmail=process.env.STARMED_SMOKE_ADMIN_EMAIL||process.env.BOOTSTRAP_ADMIN_EMAIL;
const adminPassword=process.env.STARMED_SMOKE_ADMIN_PASSWORD||process.env.BOOTSTRAP_ADMIN_PASSWORD;
if(!adminEmail||!adminPassword)throw new Error('Configure the development admin credentials');

async function request<T>(path:string,token:string|null,method='GET',body?:unknown,expected=200):Promise<T>{
  const response=await fetch(new URL(path,apiBase),{
    method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},
    body:body===undefined?undefined:JSON.stringify(body)
  });
  const content=await response.json().catch(()=>({}));
  if(response.status!==expected)throw new Error(method+' '+path+': expected '+expected+' got '+response.status+': '+JSON.stringify(content));
  return content as T;
}
type Login={accessToken:string};
type Id={id:string;version?:number};
type VersionNote=Id & {status:string};
async function main(){
  const nonce=randomUUID().slice(0,12);
  await request('/health',null);
  const unauthorized=await fetch(new URL('/patients',apiBase));
  assert.equal(unauthorized.status,401,'Protected route must reject anonymous access');
  const admin=(await request<Login>('/auth/login',null,'POST',{email:adminEmail,password:adminPassword},201)).accessToken;
  const password='Smoke-password-'+randomUUID();
  const doctorEmail='starmed-smoke-'+nonce+'@example.invalid';
  const doctor=await request<Id>('/users',admin,'POST',{email:doctorEmail,displayName:'Médico Teste '+nonce,role:'doctor',password},201);
  const token=(await request<Login>('/auth/login',null,'POST',{email:doctorEmail,password},201)).accessToken;
  const patient=await request<Id>('/patients',token,'POST',{fullName:'Paciente Fictício '+nonce,birthDate:'1990-02-05',administrativeGender:'unknown'},201);
  const allergy=await request<Id>('/patients/'+patient.id+'/allergies',token,'POST',{substance:'Substância fictícia',reaction:'Reação simulada',criticality:'high',verificationStatus:'unconfirmed'},201);
  const condition=await request<Id>('/patients/'+patient.id+'/problems',token,'POST',{display:'Hipótese clínica fictícia',verificationStatus:'provisional'},201);
  const allergies=await request<Id[]>('/patients/'+patient.id+'/allergies',token);
  assert.ok(allergies.some(a=>a.id===allergy.id));
  const problems=await request<Id[]>('/patients/'+patient.id+'/problems',token);
  assert.ok(problems.some(p=>p.id===condition.id));
  const visit=await request<Id>('/encounters',token,'POST',{patientId:patient.id,specialty:'general',type:'consultation',reasonForVisit:'Atendimento sintético'},201);
  const operationId=randomUUID();
  const draft=await request<VersionNote>('/encounters/'+visit.id+'/notes/draft',token,'PUT',{
    operationId,expectedVersion:0,templateId:'general',
    sections:{assessment:'Teste sem diagnóstico real',plan:'Sem conduta clínica; apenas verificação automatizada'}
  });
  assert.equal(draft.version,1);
  const retry=await request<VersionNote>('/encounters/'+visit.id+'/notes/draft',token,'PUT',{
    operationId,expectedVersion:0,templateId:'general',
    sections:{assessment:'Teste sem diagnóstico real',plan:'Sem conduta clínica; apenas verificação automatizada'}
  });
  assert.equal(retry.id,draft.id);
  const signed=await request<VersionNote>('/encounters/'+visit.id+'/notes/sign',token,'POST',{expectedVersion:draft.version},201);
  assert.equal(signed.status,'signed');
  await request('/encounters/'+visit.id+'/notes/draft',token,'PUT',{
    operationId:randomUUID(),expectedVersion:signed.version,templateId:'general',sections:{plan:'Tentativa de edição'}
  },409);
  const amendmentId=randomUUID();
  const addendumPayload={operationId:amendmentId,reason:'Teste de correção',content:'Texto complementar fictício registrado pelo smoke test'};
  const amend=await request<Id>('/encounters/'+visit.id+'/addenda',token,'POST',addendumPayload,201);
  const repeatAmend=await request<Id>('/encounters/'+visit.id+'/addenda',token,'POST',addendumPayload,201);
  assert.equal(amend.id,repeatAmend.id);
  const addenda=await request<Id[]>('/encounters/'+visit.id+'/addenda',token);
  assert.equal(addenda.filter(a=>a.id===amend.id).length,1);
  for(const [resource,id] of [['Patient',patient.id],['Encounter',visit.id],['AllergyIntolerance',allergy.id],['Condition',condition.id]] as const){
    const result=await request<{resourceType:string}>('/fhir/R4/'+resource+'/'+id,token);
    assert.equal(result.resourceType,resource);
  }
  const start=new Date(Date.now()+3600000).toISOString();
  await request('/appointments',token,'POST',{patientId:patient.id,practitionerId:doctor.id,scheduledAt:start,durationMinutes:30,kind:'consultation'},201);
  await request('/appointments',token,'POST',{patientId:patient.id,practitionerId:doctor.id,scheduledAt:new Date(Date.parse(start)+15*60000).toISOString(),durationMinutes:30,kind:'follow_up'},409);
  await request('/appointments',token,'POST',{patientId:patient.id,practitionerId:doctor.id,scheduledAt:new Date(Date.parse(start)+30*60000).toISOString(),durationMinutes:30,kind:'follow_up'},201);
  console.log('StarMed smoke test passed: auth, patient history, notes, immutable addenda, FHIR and booking conflicts');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
