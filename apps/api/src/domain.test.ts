import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addendumSchema, draftSchema, encounterSchema, signSchema, validateNoteForSignature } from './domain';
import { hashPassword, verifyPassword } from './security';
import { toFhirAllergy, toFhirCondition } from './fhir-mappers';

test('rejects signing a clinical note without assessment and plan',()=>{
  assert.equal(validateNoteForSignature({sections:{assessment:'',plan:'Return in 1 week'}}),false);
  assert.equal(validateNoteForSignature({sections:{assessment:'Suspected condition',plan:'Follow-up'}}),true);
});
test('draft requires optimistic version and idempotency UUID',()=>{
  assert.equal(draftSchema.safeParse({expectedVersion:-1,operationId:'oops',templateId:'general',sections:{}}).success,false);
});
test('encounter requires specialty and UUID',()=>{
  assert.equal(encounterSchema.safeParse({patientId:'bad',specialty:'general',type:'consultation',reasonForVisit:''}).success,false);
});
test('scrypt password verification',async()=>{
  const hash=await hashPassword('a-secure-local-demo-secret');
  assert.equal(await verifyPassword('a-secure-local-demo-secret',hash),true);
  assert.equal(await verifyPassword('incorrect',hash),false);
});

test('requires version for signing',()=>{
  assert.equal(signSchema.safeParse({expectedVersion:0}).success,false);
  assert.equal(signSchema.safeParse({expectedVersion:2}).success,true);
});
test('requires nonempty addendum reason/content and idempotency key',()=>{
  assert.equal(addendumSchema.safeParse({operationId:'bad',reason:'correction',content:'A clinical clarification'}).success,false);
  assert.equal(addendumSchema.safeParse({operationId:'f22ad190-a952-488d-977e-d1c86f155fbd',reason:'Correction',content:'A clinical clarification'}).success,true);
});

test('FHIR R4 allergy mapping preserves clinical/verification statuses',()=>{
  const a=toFhirAllergy({
    id:'allergy-id',patient_id:'patient-id',recorded_by:'doctor-id',
    substance:'Substância informada',reaction:'Prurido',criticality:'high',
    clinical_status:'active',verification_status:'unconfirmed',recorded_at:'2026-10-19T10:00:00.000Z'
  });
  assert.equal(a.resourceType,'AllergyIntolerance');
  assert.equal(a.criticality,'high');
  assert.equal(a.verificationStatus.coding[0].code,'unconfirmed');
  assert.equal(a.patient.reference,'Patient/patient-id');
});
test('FHIR R4 condition mapping retains terminology identifiers',()=>{
  const c=toFhirCondition({
    id:'condition-id',patient_id:'patient-id',recorded_by:'doctor-id',
    display:'Condição relatada',code_system:'http://hl7.org/fhir/sid/icd-10',code:'Z00.0',
    clinical_status:'active',verification_status:'provisional',
    onset_date:null,recorded_at:'2026-10-19T10:00:00.000Z'
  });
  assert.equal(c.resourceType,'Condition');
  assert.equal(c.verificationStatus.coding[0].code,'provisional');
  assert.equal(c.code.coding?.[0].code,'Z00.0');
});
