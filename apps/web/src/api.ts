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
export type Patient={id:string;fullName:string;birthDate:string;administrativeGender?:string;externalId?:string};
export type Encounter={id:string;patient_id:string;doctor_id:string;specialty:string;type:string;status:string;started_at:string;reason_for_visit:string};
export type ClinicalNote={id:string;encounter_id:string;template_id:string;content:{sections:Record<string,string>};version:number;status:'draft'|'signed';signed_at:string|null};
export type Doctor={id:string;displayName:string;role:Role;email:string};
export type Appointment={id:string;patient_name:string;scheduled_at:string;duration_minutes:number;kind:string;status:string};

const base=(import.meta.env.VITE_API_URL||'http://localhost:3001').replace(/\/$/,'');
export class ApiError extends Error{
  constructor(public status:number,message:string){super(message);}
}
export async function api<T>(path:string,token:string|null,method='GET',body?:unknown):Promise<T>{
  const response=await fetch(base+path,{
    method,cache:'no-store',headers:{
      'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{})
    },
    body:body===undefined?undefined:JSON.stringify(body)
  });
  const data=await response.json().catch(()=>null);
  // 401 com token de sessão = sessão inválida/expirada/revogada: o App volta ao login
  // com aviso. Chamadas públicas (login, verify/recovery MFA, sso) não têm token e,
  // por isso, um 401 delas é erro de credencial/desafio tratado localmente na tela.
  if(response.status===401&&token)window.dispatchEvent(new Event(EVENT_SESSION_EXPIRED));
  if(!response.ok)throw new ApiError(response.status,typeof data?.message==='string'?data.message:JSON.stringify(data?.message||'Falha na API'));
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
