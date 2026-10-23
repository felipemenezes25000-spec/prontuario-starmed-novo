export type Role='admin'|'doctor'|'nurse'|'reception';
export type User={id:string;displayName:string;role:Role;email:string;orgId:string};
export type Session={accessToken:string;user:User};
/** Resposta de POST /auth/login: sessão direta OU desafio MFA (sem sessão antes do 2º fator). */
export type LoginResponse={accessToken?:string;user?:User;mfaRequired?:boolean;mfaToken?:string;methods?:string[]};
/** GET /auth/mfa/status */
export type MfaStatus={enabled:boolean;enrolledAt:string|null;methods:string[]};
/** POST /auth/mfa/enroll — o endpoint devolve segredo e URI; não há imagem de QR pronta. */
export type MfaEnrollment={secretBase32:string;otpauthUri:string;algorithm:string;digits:number;periodSeconds:number};
/** EVENTO_SESSION_EXPIRED: disparado apenas quando um endpoint chamado COM token de sessão responde 401. */
export const EVENT_SESSION_EXPIRED='starmed:session-expired';
export type Patient={id:string;fullName:string;birthDate:string;administrativeGender?:string;externalId?:string;cpfMasked?:string|null;hasCns?:boolean};
export type Encounter={id:string;patient_id:string;doctor_id:string;specialty:string;type:string;status:string;started_at:string;reason_for_visit:string};
export type ClinicalNote={id:string;encounter_id:string;template_id:string;content:{sections:Record<string,string>};version:number;status:'draft'|'signed';signed_at:string|null};
export type Doctor={id:string;displayName:string;role:Role;email:string};
export type Appointment={id:string;patient_name:string;scheduled_at:string;duration_minutes:number;kind:string;status:string};

const base=(import.meta.env.VITE_API_URL||'http://localhost:3001').replace(/\/$/,'');
export class ApiError extends Error{
  /** body = corpo JSON bruto da resposta (opcional): preserva `issues` da validação
   *  (domain.parse → 400 {message, issues:[{path,message}]}) e `alerts` da segurança
   *  medicamentosa (409/422 em POST /prescriptions/:id/sign), que a mensagem sozinha descarta. */
  constructor(public status:number,message:string,public body?:unknown){super(message);}
}
/** `headers` (5º parâmetro, opcional/aditivo): sobrescreve headers por chamada — usado pelo
 *  break-glass (P0-05) para enviar `X-Break-Glass-Reason` ao repetir uma leitura de prontuário
 *  que o backend recusou com 403. Call sites existentes permanecem intactos. */
export async function api<T>(path:string,token:string|null,method='GET',body?:unknown,headers?:Record<string,string>):Promise<T>{
  const response=await fetch(base+path,{
    method,cache:'no-store',headers:{
      'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{}), ...headers
    },
    body:body===undefined?undefined:JSON.stringify(body)
  });
  const data=await response.json().catch(()=>null);
  // 401 com token de sessão = sessão inválida/expirada/revogada: o App volta ao login
  // com aviso. Chamadas públicas (login, verify/recovery MFA, sso) não têm token e,
  // por isso, um 401 delas é erro de credencial/desafio tratado localmente na tela.
  if(response.status===401&&token)window.dispatchEvent(new Event(EVENT_SESSION_EXPIRED));
  if(!response.ok)throw new ApiError(response.status,typeof data?.message==='string'?data.message:JSON.stringify(data?.message||'Falha na API'),data??undefined);
  return data as T;
}

export type ClinicalAddendum={
  id:string;note_id:string;author_id:string;author_name?:string;
  reason:string;content:string;signed_at:string;
};

export type PatientAllergy={
 id:string;substance:string;reaction:string|null;criticality:'low'|'high'|'unable-to-assess';
 clinical_status:string;verification_status:string;recorded_at:string;
};
export type PatientProblem={
 id:string;display:string;code_system:string|null;code:string|null;
 clinical_status:string;verification_status:string;onset_date:string|null;recorded_at:string;
};

/* ---- Prontuário 360° (tipos do contrato fechado; UI consumidora: pages/Record360.tsx) ---- */
/** meta é polimórfico por `kind`: prescription→signatureStatus; document→{sha256,versions};
 *  exam→{priority,critical,status}. Campos ausentes quando o kind não os define. */
export type TimelineMeta={
 signatureStatus?:'none'|'attested'|'pades';
 sha256?:string;versions?:number;
 priority?:string;critical?:boolean;status?:string;
};
/** GET /patients/:patientId/timeline?types=…&limit=50 */
export type TimelineItem={
 kind:'encounter'|'note'|'prescription'|'allergy'|'problem'|'exam'|'document'|string;
 id:string;at:string;status:string;author?:string;title:string;summary?:string;meta?:TimelineMeta;
};
/** GET /patients/:patientId/medications */
export type MedicationsBundle={
 allergyState:'recorded'|'none_recorded';
 allergies:{substance:string;criticality:string;clinicalStatus:string;verificationStatus:string}[];
 activeMedications:{id:string;medicationName:string;dose:string;frequency:string;route:string;status:string;signatureStatus:string;prescribedAt:string}[];
 alerts:{level:'info'|'review_required'|'block';code:string;message:string}[];
};
/** GET /patients/:patientId/documents */
export type DocumentRow={id:string;doc_type:string;sha256:string;created_at:string;versions:number};
/** GET /patients/:patientId/documents/:documentId/versions */
export type DocumentVersions={documentId:string;versions:{version:number;sha256:string;change_kind:string;created_at:string}[];note?:string};
