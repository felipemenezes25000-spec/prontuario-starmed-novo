import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addendumSchema, draftSchema, encounterSchema, signSchema, validateNoteForSignature } from './domain';
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

test('requires version for signing',()=>{
  assert.equal(signSchema.safeParse({expectedVersion:0}).success,false);
  assert.equal(signSchema.safeParse({expectedVersion:2}).success,true);
});
test('requires nonempty addendum reason/content and idempotency key',()=>{
  assert.equal(addendumSchema.safeParse({operationId:'bad',reason:'correction',content:'A clinical clarification'}).success,false);
  assert.equal(addendumSchema.safeParse({operationId:'f22ad190-a952-488d-977e-d1c86f155fbd',reason:'Correction',content:'A clinical clarification'}).success,true);
});
