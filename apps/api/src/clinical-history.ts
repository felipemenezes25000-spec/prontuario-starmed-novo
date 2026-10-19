import { Body, Controller, Get, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { Db } from './db';
import { parse, uuid } from './domain';
import { Actor, audit, requireRole } from './security';

type ReqWithActor = { actor:Actor };
const allergySchema=z.object({
  substance:z.string().trim().min(2).max(200),
  reaction:z.string().trim().max(1000).optional(),
  criticality:z.enum(['low','high','unable-to-assess']).default('unable-to-assess'),
  clinicalStatus:z.enum(['active','inactive','resolved']).default('active'),
  verificationStatus:z.enum(['unconfirmed','confirmed']).default('unconfirmed')
}).strict();
const problemSchema=z.object({
  display:z.string().trim().min(3).max(300),
  codeSystem:z.string().url().max(300).optional(),
  code:z.string().trim().min(1).max(50).optional(),
  clinicalStatus:z.enum(['active','resolved']).default('active'),
  verificationStatus:z.enum(['provisional','confirmed']).default('provisional'),
  onsetDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
}).strict().refine(b=>Boolean(b.codeSystem)===Boolean(b.code),{message:'codeSystem e code devem ser preenchidos juntos'});

async function ensurePatient(db:Db, patientId:string,orgId:string) {
  const p=await db.query('SELECT 1 FROM patients WHERE id=$1 AND org_id=$2',[patientId,orgId]);
  if(!p.rowCount)throw new NotFoundException('Paciente não encontrado');
}

@Controller('patients/:patientId/allergies')
export class AllergiesController {
  constructor(private db:Db){}
  @Get()
  async list(@Req() req:ReqWithActor,@Param('patientId') rawId:string){
    const actor=req.actor;requireRole(actor,['doctor','nurse']);
    const id=parse(uuid,rawId);
    await ensurePatient(this.db,id,actor.org_id);
    const records=await this.db.query('SELECT id,substance,reaction,criticality,clinical_status,verification_status,recorded_at FROM patient_allergies WHERE org_id=$1 AND patient_id=$2 ORDER BY recorded_at DESC LIMIT 200',[actor.org_id,id]);
    await audit(this.db,actor,'patient.allergies.read','patient',id);
    return records.rows;
  }
  @Post()
  async create(@Req() req:ReqWithActor,@Param('patientId') rawId:string,@Body() raw:unknown){
    const actor=req.actor;requireRole(actor,['doctor','nurse']);
    const id=parse(uuid,rawId),b=parse(allergySchema,raw);
    return this.db.tx(async c=>{
      const record=await c.query(
        'INSERT INTO patient_allergies(org_id,patient_id,recorded_by,substance,reaction,criticality,clinical_status,verification_status) SELECT $1,id,$3,$4,$5,$6,$7,$8 FROM patients WHERE org_id=$1 AND id=$2 RETURNING id,substance,reaction,criticality,clinical_status,verification_status,recorded_at',
        [actor.org_id,id,actor.id,b.substance,b.reaction||null,b.criticality,b.clinicalStatus,b.verificationStatus]);
      if(!record.rowCount)throw new NotFoundException('Paciente não encontrado');
      await c.query('INSERT INTO audit_events(org_id,actor_id,action,target_type,target_id) VALUES($1,$2,$3,$4,$5)',[actor.org_id,actor.id,'patient.allergy.recorded','patient',id]);
      return record.rows[0];
    });
  }
}

@Controller('patients/:patientId/problems')
export class ProblemsController {
  constructor(private db:Db){}
  @Get()
  async list(@Req() req:ReqWithActor,@Param('patientId') rawId:string) {
    const actor=req.actor;requireRole(actor,['doctor','nurse']);
    const id=parse(uuid,rawId);
    await ensurePatient(this.db,id,actor.org_id);
    const records=await this.db.query('SELECT id,display,code_system,code,clinical_status,verification_status,onset_date,recorded_at FROM patient_conditions WHERE org_id=$1 AND patient_id=$2 ORDER BY recorded_at DESC LIMIT 200',[actor.org_id,id]);
    await audit(this.db,actor,'patient.conditions.read','patient',id);
    return records.rows;
  }
  @Post()
  async create(@Req() req:ReqWithActor,@Param('patientId') rawId:string,@Body() raw:unknown){
    const actor=req.actor;requireRole(actor,['doctor']);
    const id=parse(uuid,rawId),b=parse(problemSchema,raw);
    return this.db.tx(async c=>{
      const record=await c.query(
        'INSERT INTO patient_conditions(org_id,patient_id,recorded_by,display,code_system,code,clinical_status,verification_status,onset_date) SELECT $1,id,$3,$4,$5,$6,$7,$8,$9 FROM patients WHERE org_id=$1 AND id=$2 RETURNING id,display,code_system,code,clinical_status,verification_status,onset_date,recorded_at',
        [actor.org_id,id,actor.id,b.display,b.codeSystem||null,b.code||null,b.clinicalStatus,b.verificationStatus,b.onsetDate||null]);
      if(!record.rowCount)throw new NotFoundException('Paciente não encontrado');
      await c.query('INSERT INTO audit_events(org_id,actor_id,action,target_type,target_id) VALUES($1,$2,$3,$4,$5)',[actor.org_id,actor.id,'patient.condition.recorded','patient',id]);
      return record.rows[0];
    });
  }
}
