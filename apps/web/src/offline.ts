import Dexie, { type Table } from 'dexie';
import { type ClinicalNote } from './api';

type CipherDraft={id:string;orgId:string;actorId:string;encounterId:string;salt:string;iv:string;encrypted:string;status:'pending'|'conflict';createdAt:number};
type DraftPayload={expectedVersion:number;operationId:string;templateId:string;sections:Record<string,string>};
const b64=(a:Uint8Array)=>btoa(String.fromCharCode(...a));
const from64=(s:string)=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
class Vault extends Dexie{
  drafts!:Table<CipherDraft,string>;
  constructor(){super('starmed-local-vault');this.version(1).stores({drafts:'id,orgId,actorId,encounterId,status,createdAt'});}
}
const vault=new Vault();
async function derive(passphrase:string,salt:Uint8Array){
  if(passphrase.length<12)throw new Error('Use uma frase-senha de 12 caracteres ou mais');
  const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(passphrase),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',salt:salt as BufferSource,iterations:310000,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
export async function queueDraft(orgId:string,actorId:string,encounterId:string,payload:DraftPayload,passphrase:string){
  if(!crypto.subtle)throw new Error('HTTPS é obrigatório para criptografia local');
  const salt=crypto.getRandomValues(new Uint8Array(16));
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const key=await derive(passphrase,salt);
  const clear=new TextEncoder().encode(JSON.stringify(payload));
  const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,clear));
  await vault.drafts.put({id:payload.operationId,orgId,actorId,encounterId,
    salt:b64(salt),iv:b64(iv),encrypted:b64(encrypted),status:'pending',createdAt:Date.now()});
}
export async function pendingCount(orgId:string,actorId:string){
  return vault.drafts.where({orgId,actorId}).count();
}
export async function syncDrafts(orgId:string,actorId:string,passphrase:string,submit:(encounterId:string,payload:DraftPayload)=>Promise<ClinicalNote>){
  const drafts=await vault.drafts.where({orgId,actorId}).sortBy('createdAt');
  let sent=0,conflicts=0;
  for(const entry of drafts){
    if(entry.status==='conflict'){conflicts++;continue;}
    const key=await derive(passphrase,from64(entry.salt));
    let content:ArrayBuffer;
    try {content=await crypto.subtle.decrypt({name:'AES-GCM',iv:from64(entry.iv)},key,from64(entry.encrypted));}
    catch {throw new Error('Não foi possível descriptografar. Confirme a frase-senha.');}
    const payload=JSON.parse(new TextDecoder().decode(content)) as DraftPayload;
    try {await submit(entry.encounterId,payload);await vault.drafts.delete(entry.id);sent++;}
    catch(e){
      if((e as {status?:number}).status===409){await vault.drafts.update(entry.id,{status:'conflict'});conflicts++;continue;}
      throw e;
    }
  }
  return {sent,conflicts};
}
