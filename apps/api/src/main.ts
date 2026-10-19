import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { ClinicalAddendaController } from './addenda';
import { AllergiesController, ProblemsController } from './clinical-history';
import { Db } from './db';
import { JwtGuard } from './security';
import { HealthController, AuthController, UsersController, PatientsController, AppointmentsController, EncountersController, FhirController, AiController } from './controllers';
import { assertSecurityConfig } from './config';

@Module({
  controllers:[HealthController,AuthController,UsersController,PatientsController,AppointmentsController,EncountersController,ClinicalAddendaController,AllergiesController,ProblemsController,FhirController,AiController],
  providers:[Db,{provide:APP_GUARD,useClass:JwtGuard}]
})
class ApiModule {}

async function bootstrap(){
  assertSecurityConfig();
  const app=await NestFactory.create(ApiModule,{bodyParser:true});
  app.use(helmet());
  app.use('/auth/login',rateLimit({windowMs:15*60*1000,limit:10,standardHeaders:'draft-7',legacyHeaders:false,message:{message:'Excesso de tentativas; tente mais tarde'}}));
  app.use((req:any,res:any,next:any)=>{res.setHeader('Cache-Control','no-store'); next();});
  app.enableCors({origin:process.env.WEB_ORIGIN || 'http://localhost:5173',methods:'GET,POST,PUT,OPTIONS',allowedHeaders:'Authorization,Content-Type'});
  await app.listen(Number(process.env.API_PORT || 3001),'127.0.0.1');
  console.log('StarMed API ready on localhost');
}
bootstrap().catch(error=>{console.error(error); process.exit(1);});
