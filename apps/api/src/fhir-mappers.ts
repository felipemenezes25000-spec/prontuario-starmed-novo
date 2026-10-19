/** Partial HL7 FHIR R4 representations. Not a complete FHIR implementation. */
const concept=(system:string,code:string)=>({coding:[{system,code}]});
const iso=(date:unknown):string | undefined =>{
  if(!date)return undefined;
  if(date instanceof Date)return date.toISOString();
  return String(date);
};
const dateOnly=(date:unknown):string|undefined=>iso(date)?.slice(0,10);

export type AllergyRow={
  id:string;patient_id:string;recorded_by:string;
  substance:string;reaction:string|null;criticality:'low'|'high'|'unable-to-assess';
  clinical_status:string;verification_status:string;recorded_at:string|Date;
};
export type ConditionRow={
  id:string;patient_id:string;recorded_by:string;display:string;
  code_system:string|null;code:string|null;
  clinical_status:string;verification_status:string;
  onset_date:string|Date|null;recorded_at:string|Date;
};

export function toFhirAllergy(a:AllergyRow){
  return {
    resourceType:'AllergyIntolerance' as const,
    id:a.id,
    clinicalStatus:concept('http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical',a.clinical_status),
    verificationStatus:concept('http://terminology.hl7.org/CodeSystem/allergyintolerance-verification',a.verification_status),
    code:{text:a.substance},
    patient:{reference:'Patient/'+a.patient_id},
    recordedDate:iso(a.recorded_at),
    recorder:{reference:'Practitioner/'+a.recorded_by},
    criticality:a.criticality,
    ...(a.reaction?{reaction:[{manifestation:[{text:a.reaction}]}]}:{})
  };
}

export function toFhirCondition(c:ConditionRow) {
  return {
    resourceType:'Condition' as const,
    id:c.id,
    clinicalStatus:concept('http://terminology.hl7.org/CodeSystem/condition-clinical',c.clinical_status),
    verificationStatus:concept('http://terminology.hl7.org/CodeSystem/condition-ver-status',c.verification_status),
    category:[concept('http://terminology.hl7.org/CodeSystem/condition-category','problem-list-item')],
    code:{
      text:c.display,
      ...(c.code&&c.code_system?{coding:[{system:c.code_system,code:c.code}]}:{})
    },
    subject:{reference:'Patient/'+c.patient_id},
    recordedDate:iso(c.recorded_at),
    recorder:{reference:'Practitioner/'+c.recorded_by},
    ...(c.onset_date?{onsetDateTime:dateOnly(c.onset_date)}:{})
  };
}
