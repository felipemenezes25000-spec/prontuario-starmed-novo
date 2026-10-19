import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftSchema, encounterSchema, validateNoteForSignature } from './domain';
import { hashPassword, verifyPassword } from './security';

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
