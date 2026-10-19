# StarMed: arquitetura lógica, segurança e roadmap

## Referências, sem engenharia reversa de código
Produto independente: inspiração funcional em EHRs de mercado, NÃO cópia de interfaces/código, algoritmos internos ou marcas de terceiros. Não é possível inferir os bancos proprietários a partir de marketing e telas. Há fornecedores que usam FHIR, outros oferecem APIs parciais; FHIR não é uma arquitetura de banco.

## Módulos
- Identidade: organização + usuário + perfil (RBAC); isolamento de tenant em todas as queries com org_id.
- Clínico: paciente, agendamento, atendimento, evolução clínica versionada, assinatura como atestação em banco (NÃO equivale a assinatura legal ICP-Brasil).
- Administração: estrutura de faturamento e estoque, sem fluxos operacionais ativos.
- Interoperabilidade: endpoints iniciais de leitura de Patient e Encounter em formato compatível com conceitos FHIR R4; sem alegação de servidor FHIR completo ou validação de perfis.
- IA: sugestão estruturada e provenance, proibida emissão de conduta/prescrição/diagnóstico final automática.
- Offline: fila criptografada no dispositivo, desbloqueio por senha do profissional, conflitos explícitos. Apenas rascunhos, nunca assinatura offline.

## Modelo
Organization 1:N Users/Patients
Patient 1:N Appointment/Encounter
Encounter 1:0..1 ClinicalNote (versão vigente no MVP)
ClinicalNote draft -> signed (imutável)
Encounter 1:N Prescription/ClinicalDocument
AuditEvent append-only

### Evolução necessária
- Adendos imutáveis básicos implementados; faltam encadeamento de versões, relações FHIR Composition, assinatura digital legal e processos de retificação/aprovação clínica.
- Consentimentos, segmentação por perfis de equipes, emergência break-glass e justificativa auditada.
- Migrações versionadas, retenção legal, backup testado, criptografia KMS, segregação de ambientes.
- IAM corporativo (OIDC + MFA), revogação e sessões curtas, rate-limit distribuído, observabilidade sem PHI.
- Assinatura digital ICP-Brasil, prescrições reguladas, protocolos por especialidade revisados clinicamente.
- Compatibilidade FHIR R4 formal via testes com validator e perfis nacionais aplicáveis; HL7 v2, DICOMweb e TISS quando necessários.
- Serviços externos (LIS/PACS/telemedicina), agenda com prevenção de colisões, faturamento real.
- Testes integrados com Postgres, E2E de permissões, restauração, DR, pentest e análise jurídica/regulatória.

## Política IA
A transcrição pode conter informação médica sensível. Nunca enviar a fornecedores sem base legal adequada, avaliação de impacto e contratos de operador/subprocessadores (e BAA quando HIPAA se aplicar), com auditoria. O backend desabilita IA por padrão e retorna somente sugestões. Proibir suposições clínicas.

## LGPD, HIPAA, interoperabilidade
Seguir boas práticas e desenhar controles não garante conformidade regulatória. HIPAA depende da jurisdição, do tipo de entidade e de contratos/processos. Dados de saúde são sensíveis no Brasil. Autenticação, trilhas e proteção em trânsito são necessários mas insuficientes.

Referências oficiais:
- HL7 FHIR R4: https://hl7.org/fhir/R4/
- HL7 FHIR Composition R4: https://hl7.org/fhir/R4/composition.html
- HHS HIPAA Security Rule: https://www.hhs.gov/hipaa/for-professionals/security/index.html
- LGPD: https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm

## Extensões implementadas na migração 003
- Restrição PostgreSQL contra sobreposição de agendamentos ativos de um mesmo profissional (GiST/intervalos, aplicada ao mesmo tenant).
- Adendos de nota atestada como registros separados e imutáveis, com motivo, texto, autoria, instante da atestação e evento de auditoria na mesma transação.
- API de atestação de notas com `expectedVersion` para prevenção de gravações desatualizadas.
- Rate limit básico de login em memória. **Não é proteção distribuída para produção** (requer Redis/gateway, MFA, políticas de IP e observabilidade).
- Redação de informações sensíveis na consulta individual do paciente para perfis sem acesso clínico.

## História clínica estruturada (migração 004)
- `patient_allergies`: substância, reação, gravidade, estado clínico e estado de verificação, autor e data; leitura por médico/enfermagem, criação pelos mesmos papéis.
- `patient_conditions`: problemas clínicos codificados opcionalmente com um URI de sistema de códigos, verificação e data de início; criação restrita a médico.
- Endpoints autenticados `GET/POST /patients/:patientId/allergies` e `GET/POST /patients/:patientId/problems`, sempre filtrados por organização.
- São registros históricos básicos e não substituem reconciliação medicamentosa, checagem de interações, prescrições ou protocolos; é obrigatório revisar a informação antes de condutas clínicas.
