export type Specialty = 'general'|'cardiology'|'orthopedics'|'pediatrics'|'neurology'|'psychiatry';
export type Field = {key:string; label:string; placeholder?:string; required?:boolean};
const base:Field[]=[
  {key:'chiefComplaint',label:'Queixa principal',placeholder:'Relato do paciente'},
  {key:'hpi',label:'História da doença atual',placeholder:'Início, evolução e características'},
  {key:'history',label:'Antecedentes e medicações',placeholder:'Alergias, condições prévias, medicamentos em uso'},
  {key:'examination',label:'Exame físico',placeholder:'Achados observados; não presuma dados'},
  {key:'assessment',label:'Avaliação clínica',placeholder:'Hipóteses, diferenciais e justificativa',required:true},
  {key:'plan',label:'Plano e orientações',placeholder:'Condutas definidas pelo médico, acompanhamento',required:true}
];
export const specialties:Record<Specialty,{name:string;fields:Field[]}>={
  general:{name:'Clínica geral',fields:base},
  cardiology:{name:'Cardiologia',fields:[...base.slice(0,4),{key:'cardiacHistory',label:'História cardiovascular'},{key:'cardiacExam',label:'Exame cardiovascular'},{key:'ecg',label:'ECG / exames disponíveis'},...base.slice(4)]},
  orthopedics:{name:'Ortopedia',fields:[...base.slice(0,4),{key:'affectedRegion',label:'Região / lateralidade'},{key:'rangeOfMotion',label:'Amplitude de movimento'},{key:'imaging',label:'Exames de imagem'},...base.slice(4)]},
  pediatrics:{name:'Pediatria',fields:[...base.slice(0,4),{key:'caregiver',label:'Responsável / fonte da história'},{key:'development',label:'Desenvolvimento e vacinação'},...base.slice(4)]},
  neurology:{name:'Neurologia',fields:[...base.slice(0,4),{key:'neurologicExam',label:'Exame neurológico'},{key:'redFlags',label:'Sinais de alerta investigados'},...base.slice(4)]},
  psychiatry:{name:'Psiquiatria',fields:[...base.slice(0,4),{key:'mentalStatus',label:'Exame do estado mental'},{key:'riskAssessment',label:'Avaliação de risco documentada'},...base.slice(4)]}
};
