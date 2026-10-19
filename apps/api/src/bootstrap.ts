import { Db } from './db';
import { assertSecurityConfig, env } from './config';
import { hashPassword } from './security';

async function main(){
  assertSecurityConfig();
  const email=env('BOOTSTRAP_ADMIN_EMAIL').trim().toLowerCase();
  const password=env('BOOTSTRAP_ADMIN_PASSWORD');
  if(password.length<12 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Valid bootstrap email and strong password required');
  const db=new Db();
  try {
    const exists=await db.query('SELECT 1 FROM users LIMIT 1');
    if(exists.rowCount)throw new Error('Bootstrap is only allowed in an empty user database');
    const org=await db.query<any>('INSERT INTO organizations(name) VALUES($1) RETURNING id',[process.env.BOOTSTRAP_ORGANIZATION||'StarMed']);
    await db.query('INSERT INTO users(org_id,email,display_name,role,password_hash) VALUES($1,$2,$3,$4,$5)',[org.rows[0].id,email,'Administrador','admin',await hashPassword(password)]);
    console.log('Organization and initial admin created. Create a doctor via POST /users.');
  } finally {await db.onModuleDestroy();}
}
main().catch(e=>{console.error(e.message); process.exit(1);});
