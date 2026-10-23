/**
 * Destructive write-oriented smoke test for a disposable local development database ONLY.
 * Requires STARMED_TEST_DB=true and STARMED_SMOKE_ADMIN_EMAIL/PASSWORD.
 * Start the API before running; never point at an environment with patient data.
 */
import { randomUUID } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { buildTestPki, pem, pkcs8Pem } from './pki/test-pki';
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
  const crmNumber=String(100000+Math.floor(Math.random()*899999));
  // Nasce SEM registro profissional: a 1ª assinatura de receita prova o 422 (029)
  // e o próprio médico cadastra o CRM — sem login extra (orçamento de 10/15min).
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
  // --- Lacunas do aceite C1 fechadas nesta rodada (dados 100% sintéticos) ---

  // 1) Prescrição de ponta a ponta: rascunho estruturado → alertas → atestação → PDF persistido.
  const rxOperationId = randomUUID();
  const rxPayload = {
    operationId: rxOperationId,
    medication:{name:'Medicamento Fictício 10 mg', form:'tablet'},
    dose:{value:10, unit:'mg'},
    route:'oral', frequency:'8/8h', duration:'5 dias',
    times:['08:00','16:00'], quantity:10,
    indication:'Indicação fictícia para verificação automatizada',
    instructions:'Sem uso real; dados sintéticos.'
  };
  const rx = await request<any>('/encounters/'+visit.id+'/prescriptions',token,'POST',rxPayload,201);
  assert.ok(Array.isArray(rx.safetyAlerts),'prescrição devolve safetyAlerts tipados');

  // 1b) Replay de operationId (J1 #9): o MESMO operationId devolve a MESMA
  //     prescrição — sem duplicar documento nem linha na lista.
  const rxReplay = await request<any>('/encounters/'+visit.id+'/prescriptions',token,'POST',rxPayload,201);
  assert.equal(rxReplay.id,rx.id,'replay do operationId devolve a mesma prescrição');
  const rxList = await request<any[]>('/patients/'+patient.id+'/prescriptions',token);
  assert.ok(rxList.some((p:any)=>p.id===rx.id),'lista de prescrições do paciente contém o rascunho');
  assert.equal(rxList.filter((p:any)=>p.id===rx.id).length,1,'replay não duplicou documento na lista');
  const rxOperationReuse = await request<any>('/encounters/'+visit.id+'/prescriptions',token,'POST',
    {...rxPayload, indication:'Outra indicação com a mesma chave'},201);
  assert.equal(rxOperationReuse.id,rx.id,'mesma chave na mesma operação continua sendo replay');
  // A MESMA chave usada em OUTRA operação (outro atendimento) é conflito — não replay.
  const visit2 = await request<Id>('/encounters',token,'POST',{patientId:patient.id,specialty:'general',type:'consultation',reasonForVisit:'Atendimento sintético 2'},201);
  const crossOp = await request<any>('/encounters/'+visit2.id+'/prescriptions',token,'POST',rxPayload,409);
  assert.ok(String((crossOp as any)?.message||'').length>0,'reuso da chave em outra operação é conflito');

  const noCrm=await request<{missing:Array<{field:string}>}>('/prescriptions/'+rx.id+'/sign',token,'POST',{operationId:randomUUID()},422);
  assert.ok(noCrm.missing.some(m=>m.field==='prescritor.crm'),'sem CRM/UF o médico não assina (029)');
  await request('/users/'+doctor.id+'/registration',token,'PUT',{councilNumber:'111111',councilState:'SP'},400);
  await request('/users/'+doctor.id+'/registration',token,'PUT',{councilNumber:'12345',councilState:'XX'},400);
  await request('/users/'+doctor.id+'/registration',admin,'PUT',{councilNumber:'12345',councilState:'SP'},200);
  await request('/users/'+randomUUID()+'/registration',token,'PUT',{councilNumber:'54321',councilState:'RJ'},403);
  await request('/users/'+doctor.id+'/registration',token,'PUT',{councilNumber:'CRM/SP '+crmNumber,councilState:'sp',professionalAddress:'Rua Fictícia, 100 - São Paulo/SP',professionalPhone:'(11) 3333-4444'},200);
  const reg=await request<{councilNumber:string;councilState:string}>('/users/'+doctor.id+'/registration',admin);
  assert.deepEqual([reg.councilNumber,reg.councilState],[crmNumber,'SP'],'CRM normalizado (só dígitos, UF maiúscula)');
  const signOperationId = randomUUID();
  const rxSigned = await request<any>('/prescriptions/'+rx.id+'/sign',token,'POST',{operationId:signOperationId},201);
  assert.equal(rxSigned.signature_status,'attested','atestação ≠ assinatura qualificada');
  // Replay do sign: mesma resposta, mesmo documento — e a fila de documentos não cresce.
  const rxSignedReplay = await request<any>('/prescriptions/'+rx.id+'/sign',token,'POST',{operationId:signOperationId},201);
  assert.equal(rxSignedReplay.document.id,rxSigned.document.id,'replay do sign devolve o mesmo documento');
  assert.equal(rxSignedReplay.signature_status,'attested');
  // Documento único: uma nova tentativa de assinar (chave nova) falha sem duplicar.
  await request('/prescriptions/'+rx.id+'/sign',token,'POST',{operationId:randomUUID()},409);
  const pdfRes = await fetch(new URL('/prescriptions/'+rx.id+'/pdf',apiBase),{headers:{authorization:'Bearer '+token}});
  assert.equal(pdfRes.status,200,'PDF persistido é servido');
  const pdfBytes = Buffer.from(await pdfRes.arrayBuffer());
  assert.ok(pdfBytes.subarray(0,5).toString('latin1')==='%PDF-','artefato começa com %PDF');
  assert.ok(pdfBytes.toString('latin1').includes('CRM '+crmNumber+'/SP'),'PDF identifica o prescritor por CRM/UF (029)');
  assert.equal(rxSigned.kind,'simple');
  assert.equal(rxSigned.valid_until,null,'receita simples sem validade regulatória fixa');

  // 029: tipos de receita e registro profissional do prescritor.
  const kinds=await request<{kinds:Array<{kind:string;enabled:boolean;reason:string|null}>}>('/prescription-kinds',token);
  assert.equal(kinds.kinds.find(k=>k.kind==='controlled_special')?.enabled,false,'controle especial nunca sem SNCR');
  await request('/encounters/'+visit.id+'/prescriptions',token,'POST',{...rxPayload,operationId:randomUUID(),kind:'controlled_special'},409);
  // Lote 3: substância regulada no tipo errado nunca vira rascunho (marca → princípio ativo).
  const clz=await request<{code?:string}>('/encounters/'+visit.id+'/prescriptions',token,'POST',{...rxPayload,operationId:randomUUID(),medication:{name:'Rivotril 2 mg',form:'tablet'}},409);
  assert.equal(clz.code,'kind_substance_mismatch','controle especial não sai em receita simples');
  await request('/encounters/'+visit.id+'/prescriptions',token,'POST',{...rxPayload,operationId:randomUUID(),medication:{name:'Amoxil 500 mg',form:'capsule'}},409);
  if(!kinds.kinds.find(k=>k.kind==='antimicrobial')?.enabled)
    await request('/encounters/'+visit.id+'/prescriptions',token,'POST',{...rxPayload,operationId:randomUUID(),kind:'antimicrobial'},409);

  // 2) J1 #8: certificado FORA do trust store ICP-Brasil (CA de teste) → 400, sem emissão.
  const testPki = await buildTestPki();
  const badPades = await fetch(new URL('/prescriptions/'+rx.id+'/sign-pades',apiBase),{
    method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},
    body:JSON.stringify({
      signerCertPem: pem(testPki.rogueLeaf),
      privateKeyPkcs8Pem: await pkcs8Pem(testPki.rogueLeaf.privateKey),
      councilNumber:'123456', councilState:'SP'
    })
  });
  assert.equal(badPades.status,400,'cadeia fora do trust store ICP-Brasil deve ser rejeitada (J1 #8)');

  // 3) D5/J1 #12: resultado crítico entra na fila e só some com reconhecimento auditado.
  const order = await request<any>('/hospital/orders',token,'POST',
    {patientId:patient.id,orderType:'lab',description:'Hemograma fictício',priority:'urgent'},201);
  await request('/hospital/orders/'+order.id+'/status',token,'PATCH',{status:'in_progress',critical:true});
  const pendingBefore = await request<any[]>('/hospital/orders/critical/pending',token);
  assert.ok(pendingBefore.some((o:any)=>o.id===order.id),'resultado crítico sem ack fica na fila');
  await request('/hospital/orders/'+order.id+'/critical-ack',token,'POST',undefined,201);
  const pendingAfter = await request<any[]>('/hospital/orders/critical/pending',token);
  assert.ok(!pendingAfter.some((o:any)=>o.id===order.id),'reconhecimento esvazia a fila');

  // 4) Auditoria legível pelo admin com requestId correlacionável (readback do P0-05).
  const auditEvents = await request<any[]>('/audit/events?action=prescription.signed',admin);
  assert.ok(auditEvents.length>=1,'auditoria registra prescription.signed');
  assert.ok(auditEvents[0].details && typeof auditEvents[0].details.requestId==='string',
    'evento de auditoria carrega requestId para correlação');

  // Identificadores BR (028): CPF/CNS sintéticos gerados por execução (DV válido,
  // sem titular real), unicidade por org entre ATIVOS, DV conferido na API e no banco.
  const cpf=syntheticCpf(),cns=syntheticCns();
  const withDocs=await request<Id>('/patients',token,'POST',{fullName:'Paciente Documento '+nonce,birthDate:'1984-07-09',cpf:cpf.replace(/^(d{3})(d{3})(d{3})/,'$1.$2.$3-'),cns},201);
  await request('/patients',token,'POST',{fullName:'Outro '+nonce,birthDate:'1984-07-09',cpf},409);
  await request('/patients',token,'POST',{fullName:'Outro '+nonce,birthDate:'1984-07-09',cns},409);
  await request('/patients',token,'POST',{fullName:'DV errado '+nonce,birthDate:'1984-07-09',cpf:cpf.slice(0,10)+String((Number(cpf[10])+1)%10)},400);
  await request('/patients',token,'POST',{fullName:'Sem documento '+nonce,birthDate:'1984-07-09',cpf:'',cns:''},201);
  const byCpf=await request<Array<{id:string;cpfMasked:string|null}>>('/patients?q='+cpf,token);
  assert.equal(byCpf.length,1,'busca por CPF deve ser exata');
  assert.equal(byCpf[0].id,withDocs.id);
  assert.equal(byCpf[0].cpfMasked,'***.***.***-'+cpf.slice(-2),'lista mostra só os 2 últimos dígitos');
  assert.ok(!JSON.stringify(byCpf).includes(cpf),'CPF completo não pode vazar na listagem');
  const fhirByCns=await request<{total:number;entry?:Array<{resource:{id:string;identifier:Array<{system:string;value:string}>}}>}>('/fhir/R4/Patient?identifier='+encodeURIComponent('http://rnds.saude.gov.br/fhir/r4/NamingSystem/cns|'+cns),token);
  assert.equal(fhirByCns.total,1);
  assert.ok(fhirByCns.entry?.[0].resource.identifier.some(i=>i.value===cpf),'Patient FHIR carrega o CPF da RNDS');
  await request('/fhir/R4/Patient?identifier='+encodeURIComponent('urn:outro|123'),token,'GET',undefined,400);
  console.log('StarMed smoke test passed: auth, patient history, notes, immutable addenda, FHIR, booking conflicts, prescription+PDF, rejected foreign cert, critical-result ack, audit readback, BR identifiers (CPF/CNS)');
}
main().catch(e=>{console.error(e);process.exitCode=1;});

/** CPF sintético com DV válido (9 dígitos aleatórios; descarta sequência uniforme). */
function syntheticCpf():string{
  for(;;){
    const d=Array.from({length:9},()=>Math.floor(Math.random()*10));
    if(d.every(x=>x===d[0]))continue;
    for(const len of [9,10]){let sum=0;for(let i=0;i<len;i++)sum+=d[i]*(len+1-i);const r=sum%11;d.push(r<2?0:11-r);}
    return d.join('');
  }
}
/** CNS provisório sintético (prefixo 8): último dígito fecha a soma ponderada em múltiplo de 11. */
function syntheticCns():string{
  for(;;){
    const d=[8,...Array.from({length:13},()=>Math.floor(Math.random()*10))];
    let sum=0;for(let i=0;i<14;i++)sum+=d[i]*(15-i);
    const last=(11-sum%11)%11;
    if(last<=9)return [...d,last].join('');
  }
}
