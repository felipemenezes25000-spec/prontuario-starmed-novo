export type Role='admin'|'doctor'|'nurse'|'reception';
export type User={id:string;displayName:string;role:Role;email:string;orgId:string};
export type Session={accessToken:string;user:User};
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
  if(!response.ok)throw new ApiError(response.status,typeof data?.message==='string'?data.message:JSON.stringify(data?.message||'Falha na API'));
  return data as T;
}

export type ClinicalAddendum={
  id:string;note_id:string;author_id:string;author_name?:string;
  reason:string;content:string;signed_at:string;
};
