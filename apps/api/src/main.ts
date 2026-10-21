import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { PgRateLimitStore, rateLimitMiddleware } from './rate-limit';
import { ClinicalAddendaController } from './addenda';
import { AllergiesController, ProblemsController } from './clinical-history';
import { MfaController, MfaService } from './auth-mfa';
import { SsoController, OidcService } from './sso';
import { Db } from './db';
import { JwtGuard, requestContext } from './security';
import { HealthController, AuthController, UsersController, PatientsController, AppointmentsController, EncountersController, FhirController, AiController, AuditController } from './controllers';
import { FhirExtraController, SmartWellKnownController } from './fhir-extra';
import { SignatureController, SignatureVerifyController } from './signature';
import { InteropController } from './interop/interop.controller';
import { TeleconsultController } from './teleconsult';
import { AiClinicalController } from './ai-clinical';
import { StaffPortalController, PatientPortalController } from './portal';
import { LgpdController, PatientLgpdController } from './lgpd';
import { HospitalController } from './hospital';
import { HospitalOrdersResultsController } from './orders';
import { ProductController } from './product';
import { EncounterPrescriptionsController, PatientPrescriptionsController, PrescriptionsController } from './prescriptions';
import { TimelineController, DocumentsController } from './timeline';
import { MedicationsController } from './medications';
import { MpiCandidatesController, PatientMergeController } from './mpi';
import { assertSecurityConfig } from './config';

@Module({
  controllers:[
    HealthController,AuthController,UsersController,PatientsController,AppointmentsController,EncountersController,
    ClinicalAddendaController,AllergiesController,ProblemsController,FhirController,AiController,MfaController,SsoController,
    FhirExtraController,SmartWellKnownController,SignatureController,SignatureVerifyController,InteropController,
    TeleconsultController,AiClinicalController,StaffPortalController,PatientPortalController,HospitalController,ProductController,
    LgpdController,PatientLgpdController,EncounterPrescriptionsController,PatientPrescriptionsController,PrescriptionsController,
    TimelineController,DocumentsController,MedicationsController,MpiCandidatesController,PatientMergeController,
    HospitalOrdersResultsController,
    AuditController
  ],
  providers:[Db,MfaService,OidcService,{provide:APP_GUARD,useClass:JwtGuard}]
})
class ApiModule {}

async function bootstrap(){
  assertSecurityConfig();
  const app=await NestFactory.create(ApiModule,{bodyParser:true});
  app.use(helmet());
  // Proxy reverso real (produção): TRUST_PROXY=true habilita X-Forwarded-For —
  // só ative atrás do proxy que sobrescreve o header (senão o IP é forjável).
  // Ajuste é do Express subjacente (getInstance é any no HttpAdapter do Nest).
  if(process.env.TRUST_PROXY==='true') app.getHttpAdapter().getInstance().set('trust proxy', 1);
  // CORS ANTES de qualquer middleware que possa encurtar a resposta (rate limit
  // responde 429 sem passar adiante): sem isso, um 429/login sai SEM header de
  // CORS e o navegador mascara o erro real como "não foi possível conectar".
  // PATCH é necessário: rotas @Patch existentes (ex.: PATCH /hospital/orders/:id/status,
  // PATCH /prescriptions/:id) falhariam no preflight do navegador sem ele.
  // X-Break-Glass-Reason: sem ele o retry do painel de break-glass é BLOQUEADO pelo
  // preflight quando web e API estão em origens diferentes (a UI nunca funcionou
  // cross-origin nesse fluxo — E2E descobriu; o smoke via curl não passa por CORS).
  // X-Teleconsult-Token: token de sala do paciente na sinalização WebRTC — header
  // custom fora da lista também morria no preflight ("Failed to fetch" no poll).
  app.enableCors({origin:process.env.WEB_ORIGIN || 'http://localhost:5173',methods:'GET,POST,PUT,PATCH,OPTIONS',allowedHeaders:'Authorization,Content-Type,X-Break-Glass-Reason,X-Teleconsult-Token'});
  // Rate limit DISTRIBUÍDO (P0-07): contador em Postgres (021), compartilhado
  // entre instâncias — mesmas rotas e mesmos limites de antes, sem segredo novo.
  const rateLimiter=(route:string,message:string,limit:number,minutes:number)=>
    rateLimitMiddleware(new PgRateLimitStore(app.get(Db)),route,limit,minutes*60*1000,message);
  app.use('/auth/login', rateLimiter('auth.login','Excesso de tentativas; tente mais tarde',10,15));
  app.use('/auth/mfa/verify', rateLimiter('auth.mfa.verify','Excesso de tentativas de MFA; tente mais tarde',10,15));
  app.use('/auth/mfa/recovery', rateLimiter('auth.mfa.recovery','Excesso de tentativas de recuperação; tente mais tarde',10,15));
  app.use('/auth/sso/start', rateLimiter('auth.sso.start','Excesso de inícios de SSO; tente mais tarde',30,15));
  app.use('/auth/sso/callback', rateLimiter('auth.sso.callback','Excesso de callbacks SSO; tente mais tarde',30,15));
  // Rota pública do Guia ITI (VALIDAR): sem limite por IP do validador, mas com teto defensivo.
  app.use('/verify', rateLimiter('verify.public','Excesso de consultas de validação; tente mais tarde',120,15));
  app.use((req:any,res:any,next:any)=>{res.setHeader('Cache-Control','no-store'); next();});
  // Request-Id (P0-05/C5): aceita um id saudável do chamador ou gera um; sempre
  // ecoado no header e propagado ao contexto (audit_events.details.requestId).
  app.use((req:any,res:any,next:any)=>{
    const incoming=typeof req.headers['x-request-id']==='string'?req.headers['x-request-id']:'';
    const requestId=/^[\w.:-]{1,64}$/.test(incoming)?incoming:randomUUID();
    res.setHeader('X-Request-Id',requestId);
    requestContext.run({requestId},next);
  });
  await app.listen(Number(process.env.API_PORT || 3001),'127.0.0.1');
  console.log('StarMed API ready on localhost');
}
bootstrap().catch(error=>{console.error(error); process.exit(1);});
