import { Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { Db } from './db';
import { addendumSchema, parse, uuid } from './domain';
import { Actor, audit, requireRole } from './security';

type RequestWithActor = { actor: Actor };

@Controller('encounters/:encounterId/addenda')
export class ClinicalAddendaController {
  constructor(private readonly db:Db) {}

  @Get()
  async list(@Req() req:RequestWithActor, @Param('encounterId') rawId:string) {
    const actor=req.actor;
    requireRole(actor,['doctor','nurse']);
    const encounterId=parse(uuid,rawId);
    const encounter=await this.db.query('SELECT id FROM encounters WHERE id=$1 AND org_id=$2',[encounterId,actor.org_id]);
    if (!encounter.rowCount) throw new NotFoundException('Atendimento não encontrado');
    const result=await this.db.query(
      'SELECT a.id,a.note_id,a.author_id,a.reason,a.content,a.signed_at,u.display_name AS author_name FROM clinical_note_addenda a JOIN clinical_notes n ON n.id=a.note_id AND n.org_id=a.org_id JOIN users u ON u.id=a.author_id AND u.org_id=a.org_id WHERE n.encounter_id=$1 AND n.org_id=$2 ORDER BY a.signed_at,a.id',
      [encounterId,actor.org_id]
    );
    await audit(this.db,actor,'note.addenda.read','encounter',encounterId);
    return result.rows;
  }

  @Post()
  async append(@Req() req:RequestWithActor, @Param('encounterId') rawId:string, @Body() raw:unknown) {
    const actor=req.actor;
    requireRole(actor,['doctor']);
    const encounterId=parse(uuid,rawId);
    const body=parse(addendumSchema,raw);
    return this.db.tx(async client=>{
      const e=await client.query<{doctor_id:string}>(
        'SELECT doctor_id FROM encounters WHERE id=$1 AND org_id=$2 FOR UPDATE',
        [encounterId,actor.org_id]);
      if(!e.rowCount)throw new NotFoundException('Atendimento não encontrado');
      if(e.rows[0].doctor_id!==actor.id)throw new ForbiddenException('Somente médico responsável pode criar adendo');
      const replay=await client.query<{operation:string;response:any}>(
        'SELECT operation,response FROM idempotency_keys WHERE org_id=$1 AND key=$2',
        [actor.org_id,body.operationId]);
      if(replay.rowCount){
        if(replay.rows[0].operation!=='note.addendum:'+encounterId)throw new ConflictException('Chave de idempotência reutilizada');
        return replay.rows[0].response;
      }
      const n=await client.query<{id:string;status:string}>(
        'SELECT id,status FROM clinical_notes WHERE encounter_id=$1 AND org_id=$2 FOR UPDATE',
        [encounterId,actor.org_id]);
      if(!n.rowCount || n.rows[0].status!=='signed')throw new ConflictException('A nota precisa estar atestada');
      const inserted=await client.query(
        'INSERT INTO clinical_note_addenda(org_id,note_id,author_id,reason,content) VALUES($1,$2,$3,$4,$5) RETURNING id,note_id,author_id,reason,content,signed_at',
        [actor.org_id,n.rows[0].id,actor.id,body.reason,body.content]);
      await client.query(
        'INSERT INTO audit_events(org_id,actor_id,action,target_type,target_id) VALUES($1,$2,$3,$4,$5)',
        [actor.org_id,actor.id,'note.addendum.signed','encounter',encounterId]);
      await client.query(
        'INSERT INTO idempotency_keys(org_id,key,operation,response) VALUES($1,$2,$3,$4)',
        [actor.org_id,body.operationId,'note.addendum:'+encounterId,JSON.stringify(inserted.rows[0])]);
      return inserted.rows[0];
    });
  }
}
