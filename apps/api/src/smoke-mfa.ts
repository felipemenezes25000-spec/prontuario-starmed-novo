/**
 * MFA end-to-end smoke: enrollment, activation, TOTP step-up login, recovery codes
 * and disable. Requires STARMED_TEST_DB=true and a disposable local database ONLY.
 * Start the API before running; never point at an environment with patient data.
 */
import { randomUUID } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { base32Decode, totpAt } from './totp';
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
type Login={accessToken?:string;mfaRequired?:boolean;mfaToken?:string};
type Id={id:string};

async function main(){
  const nonce=randomUUID().slice(0,12);
  const admin=(await request<Login>('/auth/login',null,'POST',{email:adminEmail,password:adminPassword},201)).accessToken!;
  const password='Smoke-mfa-'+randomUUID();
  const email='starmed-mfa-'+nonce+'@example.invalid';
  await request<Id>('/users',admin,'POST',{email,displayName:'MFA Teste '+nonce,role:'doctor',password},201);
  const mfaUser=(await request<any>('/users',admin)).find((u:any)=>u.email===email);
  assert.ok(mfaUser,'created user must be listed');

  // Session for enrollment
  let token=(await request<Login>('/auth/login',null,'POST',{email,password},201)).accessToken!;
  const status0=await request<{enabled:boolean}>('/auth/mfa/status',token);
  assert.equal(status0.enabled,false);

  const enrolled=await request<{secretBase32:string;otpauthUri:string;digits:number;periodSeconds:number}>('/auth/mfa/enroll',token,'POST',{},201);
  assert.equal(enrolled.digits,6);
  assert.equal(enrolled.periodSeconds,30);
  assert.ok(enrolled.otpauthUri.startsWith('otpauth://totp/'));
  const codeAt=()=>totpAt(base32Decode(enrolled.secretBase32),Date.now());
  const badActivate=await fetch(new URL('/auth/mfa/activate',apiBase),{
    method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({code:'000000'})
  });
  assert.equal(badActivate.status,401,'activation must reject wrong codes');

  const activated=await request<{enabled:boolean;recoveryCodes:string[]}>('/auth/mfa/activate',token,'POST',{code:codeAt()},201);
  assert.equal(activated.enabled,true);
  assert.equal(activated.recoveryCodes.length,10);

  const status1=await request<{enabled:boolean}>('/auth/mfa/status',token);
  assert.equal(status1.enabled,true);

  // Login now requires the second factor and must not leak a session before it.
  const step=await request<Login>('/auth/login',null,'POST',{email,password},201);
  assert.equal(step.mfaRequired,true);
  assert.ok(!step.accessToken,'no session before MFA verification');
  assert.ok(step.mfaToken);

  const wrongCode=await fetch(new URL('/auth/mfa/verify',apiBase),{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mfaToken:step.mfaToken,code:'000000'})
  });
  assert.equal(wrongCode.status,401,'verification must reject wrong codes');

  const verified=await request<Login>('/auth/mfa/verify',null,'POST',{mfaToken:step.mfaToken,code:codeAt()},201);
  assert.ok(verified.accessToken,'verified login returns a session');
  token=verified.accessToken!;

  // Recovery code path (single use).
  const step2=await request<Login>('/auth/login',null,'POST',{email,password},201);
  const recoveryCode=activated.recoveryCodes[0];
  const used=await request<Login>('/auth/mfa/recovery',null,'POST',{mfaToken:step2.mfaToken,recoveryCode},201);
  assert.ok(used.accessToken);
  const replay=await fetch(new URL('/auth/mfa/recovery',apiBase),{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mfaToken:step2.mfaToken,recoveryCode})
  });
  assert.equal(replay.status,401,'recovery codes are single-use');

  // Regeneration invalidates the previous set.
  const regenerated=await request<{recoveryCodes:string[]}>('/auth/mfa/recovery-codes',token,'POST',{password,code:codeAt()},201);
  assert.equal(regenerated.recoveryCodes.length,10);
  assert.ok(!regenerated.recoveryCodes.includes(recoveryCode));

  // Disable revokes sessions (auth_version bump) and restores password-only login.
  const disabled=await request<{enabled:boolean;sessionsRevoked:boolean}>('/auth/mfa/disable',token,'POST',{password,code:codeAt()},201);
  assert.equal(disabled.enabled,false);
  assert.equal(disabled.sessionsRevoked,true);
  const revoked=await fetch(new URL('/auth/mfa/status',apiBase),{headers:{authorization:'Bearer '+token}});
  assert.equal(revoked.status,401,'sessions must be revoked after disabling MFA');
  const plain=await request<Login>('/auth/login',null,'POST',{email,password},201);
  assert.ok(plain.accessToken,'password-only login restored');

  console.log('StarMed MFA smoke passed: enroll, activate, TOTP step-up, single-use recovery, regenerate, disable');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
