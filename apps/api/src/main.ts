import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { ClinicalAddendaController } from './addenda';
import { AllergiesController, ProblemsController } from './clinical-history';
import { MfaController, MfaService } from './auth-mfa';
import { SsoController, OidcService } from './sso';
import { Db } from './db';
import { JwtGuard } from './security';
import { HealthController, AuthController, UsersController, PatientsController, AppointmentsController, EncountersController, FhirController, AiController } from './controllers';
import { FhirExtraController, SmartWellKnownController } from './fhir-extra';
import { SignatureController, SignatureVerifyController } from './signature';
import { InteropController } from './interop/interop.controller';
import { TeleconsultController } from './teleconsult';
import { AiClinicalController } from './ai-clinical';
import { StaffPortalController, PatientPortalController } from './portal';
import { LgpdController, PatientLgpdController } from './lgpd';
import { HospitalController } from './hospital';
import { ProductController } from './product';
import { EncounterPrescriptionsController, PatientPrescriptionsController, PrescriptionsController } from './prescriptions';
import { assertSecurityConfig } from './config';

@Module({
  controllers:[
    HealthController,AuthController,UsersController,PatientsController,AppointmentsController,EncountersController,
    ClinicalAddendaController,AllergiesController,ProblemsController,FhirController,AiController,MfaController,SsoController,
    FhirExtraController,SmartWellKnownController,SignatureController,SignatureVerifyController,InteropController,
    TeleconsultController,AiClinicalController,StaffPortalController,PatientPortalController,HospitalController,ProductController,
    LgpdController,PatientLgpdController,EncounterPrescriptionsController,PatientPrescriptionsController,PrescriptionsController
  ],
  providers:[Db,MfaService,OidcService,{provide:APP_GUARD,useClass:JwtGuard}]
})
class ApiModule {}

async function bootstrap(){
  assertSecurityConfig();
  const app=await NestFactory.create(ApiModule,{bodyParser:true});
  app.use(helmet());
  const limiter=(message:string,limit:number)=>rateLimit({windowMs:15*60*1000,limit,standardHeaders:'draft-7',legacyHeaders:false,message:{message}});
  app.use('/auth/login',limiter('Excesso de tentativas; tente mais tarde',10));
  app.use('/auth/mfa/verify',limiter('Excesso de tentativas de MFA; tente mais tarde',10));
  app.use('/auth/mfa/recovery',limiter('Excesso de tentativas de recuperação; tente mais tarde',10));
  app.use('/auth/sso/start',limiter('Excesso de inícios de SSO; tente mais tarde',30));
  app.use('/auth/sso/callback',limiter('Excesso de callbacks SSO; tente mais tarde',30));
  // Rota pública do Guia ITI (VALIDAR): sem limite por IP do validador, mas com teto defensivo.
  app.use('/verify',limiter('Excesso de consultas de validação; tente mais tarde',120));
  app.use((req:any,res:any,next:any)=>{res.setHeader('Cache-Control','no-store'); next();});
  // PATCH é necessário: rotas @Patch existentes (ex.: PATCH /hospital/orders/:id/status,
  // PATCH /prescriptions/:id) falhariam no preflight do navegador sem ele.
  app.enableCors({origin:process.env.WEB_ORIGIN || 'http://localhost:5173',methods:'GET,POST,PUT,PATCH,OPTIONS',allowedHeaders:'Authorization,Content-Type'});
  await app.listen(Number(process.env.API_PORT || 3001),'127.0.0.1');
  console.log('StarMed API ready on localhost');
}
bootstrap().catch(error=>{console.error(error); process.exit(1);});
