-- ============================================================================
--  ⚠  SCRIPT DESTRUTIVO — APAGA PRONTUARIO E TRILHA DE AUDITORIA  ⚠
-- ============================================================================
--
--  Este script DESLIGA os triggers de retencao CFM (trg_no_delete_encounters,
--  trg_no_delete_medical_documents, trg_no_delete_consultation_anamnesis) e o
--  trigger append-only de prescription_verification_logs, e entao apaga
--  encounters, medical_documents, receitas, anamnese e logs de verificacao.
--
--  Rodado por engano contra producao, o resultado e perda IRREVERSIVEL de
--  prontuario. Nao ha undo: os triggers existem justamente porque a retencao de
--  20 anos (CFM 1.821/2007) e obrigacao legal, e o DELETE some com a prova de
--  que os documentos existiram.
--
--  USO CORRETO — banco de DESENVOLVIMENTO, com as duas confirmacoes explicitas:
--
--      psql "$DEV_DATABASE_URL" \
--           -v confirmar_purge=SIM_APAGAR_TUDO \
--           -v banco_esperado=renoveja_dev \
--           -f purge_transactional_data.sql
--
--  Sem as duas variaveis, o script aborta antes de tocar em qualquer linha.
--  `banco_esperado` tem que bater com current_database(): e o que impede que um
--  DATABASE_URL errado no shell (a conexao de prod aberta na aba do lado)
--  execute o purge no banco errado. E o nome do banco de producao ('renoveja',
--  ver infra/database.tf) e recusado sempre, mesmo que alguem o informe.
-- ============================================================================

\timing on
\set ON_ERROR_STOP on

-- Guarda 1 (psql, antes de abrir a transacao): as variaveis existem?
\if :{?confirmar_purge}
\else
\echo 'ABORTADO: falta -v confirmar_purge=SIM_APAGAR_TUDO. Leia o cabecalho deste arquivo.'
\quit
\endif

\if :{?banco_esperado}
\else
\echo 'ABORTADO: falta -v banco_esperado=<nome do banco de dev>. Leia o cabecalho deste arquivo.'
\quit
\endif

BEGIN;

-- Guarda 2 (servidor, dentro da transacao): as variaveis valem o que precisam
-- valer E o banco conectado e mesmo o que o operador declarou. Qualquer falha
-- aqui levanta excecao, ON_ERROR_STOP interrompe e o BEGIN acima faz rollback —
-- nenhuma linha e apagada.
--
-- As variaveis viajam por GUC de sessao e nao direto no DO: o psql NAO interpola
-- :variavel dentro de string dollar-quoted ($$...$$), entao um :'confirmar_purge'
-- escrito dentro do bloco chegaria literal ao servidor e viraria erro de sintaxe.
-- No SET abaixo a interpolacao acontece normalmente (esta fora de aspas).
SET LOCAL renoveja.confirmar_purge = :'confirmar_purge';
SET LOCAL renoveja.banco_esperado  = :'banco_esperado';

DO $$
DECLARE
  confirmacao     TEXT := current_setting('renoveja.confirmar_purge', true);
  banco_declarado TEXT := current_setting('renoveja.banco_esperado', true);
  banco_atual     TEXT := current_database();
BEGIN
  IF confirmacao IS DISTINCT FROM 'SIM_APAGAR_TUDO' THEN
    RAISE EXCEPTION
      'ABORTADO: confirmar_purge=% nao confere. Use -v confirmar_purge=SIM_APAGAR_TUDO.',
      confirmacao;
  END IF;

  IF banco_declarado IS DISTINCT FROM banco_atual THEN
    RAISE EXCEPTION
      'ABORTADO: conectado em "%" mas o operador declarou "%". Conexao errada — confira o DATABASE_URL.',
      banco_atual, banco_declarado;
  END IF;

  -- Nome do banco de producao (infra/database.tf: db_name = "renoveja").
  -- Recusado incondicionalmente: nenhuma combinacao de variaveis libera o purge la.
  IF banco_atual = 'renoveja' THEN
    RAISE EXCEPTION
      'ABORTADO: "%" e o banco de PRODUCAO. Este script apaga prontuario e nunca deve rodar aqui.',
      banco_atual;
  END IF;

  RAISE NOTICE 'Guarda de ambiente OK: banco "%" liberado para purge.', banco_atual;
END $$;

\echo '=== 0) CONTAGEM ANTES ==='
SELECT 'requests'                          AS tabela, COUNT(*) FROM public.requests
UNION ALL SELECT 'prescriptions',                    COUNT(*) FROM public.prescriptions
UNION ALL SELECT 'prescription_verification_logs',   COUNT(*) FROM public.prescription_verification_logs
UNION ALL SELECT 'consultation_anamnesis',           COUNT(*) FROM public.consultation_anamnesis
UNION ALL SELECT 'encounters',                       COUNT(*) FROM public.encounters
UNION ALL SELECT 'medical_documents',                COUNT(*) FROM public.medical_documents
UNION ALL SELECT 'video_rooms',                      COUNT(*) FROM public.video_rooms
UNION ALL SELECT 'ai_interaction_logs',              COUNT(*) FROM public.ai_interaction_logs
UNION ALL SELECT 'ai_suggestions',                   COUNT(*) FROM public.ai_suggestions
UNION ALL SELECT 'document_access_log',              COUNT(*) FROM public.document_access_log
UNION ALL SELECT 'notifications',                    COUNT(*) FROM public.notifications
UNION ALL SELECT 'care_plans',                       COUNT(*) FROM public.care_plans
UNION ALL SELECT 'outbox_events',                    COUNT(*) FROM public.outbox_events
UNION ALL SELECT 'patient_clinical_events',          COUNT(*) FROM public.patient_clinical_events
UNION ALL SELECT 'payments',                         COUNT(*) FROM public.payments
UNION ALL SELECT 'payment_attempts',                 COUNT(*) FROM public.payment_attempts
ORDER BY tabela;

\echo ''
\echo '=== 1) DESABILITANDO triggers CFM (temporario, dentro da transacao) ==='
ALTER TABLE public.consultation_anamnesis DISABLE TRIGGER trg_no_delete_consultation_anamnesis;
ALTER TABLE public.encounters             DISABLE TRIGGER trg_no_delete_encounters;
ALTER TABLE public.medical_documents      DISABLE TRIGGER trg_no_delete_medical_documents;
-- Trilha de auditoria append-only (AuditAppendOnlyMigrations no MigrationRunner):
-- prescription_verification_logs recusa DELETE por padrao. Purge e excecao deliberada.
ALTER TABLE public.prescription_verification_logs DISABLE TRIGGER trg_prescription_verification_logs_no_delete;

\echo ''
\echo '=== 2) DELETE: payments/attempts ==='
DELETE FROM public.payment_attempts;
DELETE FROM public.payments;

\echo ''
\echo '=== 3) DELETE: logs e dependentes ==='
DELETE FROM public.prescription_verification_logs;
DELETE FROM public.consultation_anamnesis;
DELETE FROM public.video_rooms;
DELETE FROM public.ai_interaction_logs;
DELETE FROM public.ai_suggestions;
DELETE FROM public.consultation_time_bank_transactions;
DELETE FROM public.document_access_log;
DELETE FROM public.doctor_patient_notes WHERE request_id IS NOT NULL;
DELETE FROM public.chat_messages;

\echo ''
\echo '=== 4) DELETE: care plans ==='
DELETE FROM public.care_plan_task_files;
DELETE FROM public.care_plan_tasks;
DELETE FROM public.care_plans;

\echo ''
\echo '=== 5) DELETE: outbox + webhook ==='
DELETE FROM public.outbox_events;
DELETE FROM public.webhook_events;

\echo ''
\echo '=== 6) DELETE: tabelas principais ==='
DELETE FROM public.medical_documents;
DELETE FROM public.prescriptions;
DELETE FROM public.encounters;
DELETE FROM public.requests;

\echo ''
\echo '=== 7) DELETE: notificacoes + clinical events ==='
DELETE FROM public.notifications;
DELETE FROM public.patient_clinical_events;

\echo ''
\echo '=== 8) RE-HABILITANDO triggers CFM ==='
ALTER TABLE public.consultation_anamnesis ENABLE TRIGGER trg_no_delete_consultation_anamnesis;
ALTER TABLE public.encounters             ENABLE TRIGGER trg_no_delete_encounters;
ALTER TABLE public.medical_documents      ENABLE TRIGGER trg_no_delete_medical_documents;
ALTER TABLE public.prescription_verification_logs ENABLE TRIGGER trg_prescription_verification_logs_no_delete;

\echo ''
\echo '=== 9) CONTAGEM DEPOIS (deve ser tudo zero) ==='
SELECT 'requests'                          AS tabela, COUNT(*) FROM public.requests
UNION ALL SELECT 'prescriptions',                    COUNT(*) FROM public.prescriptions
UNION ALL SELECT 'prescription_verification_logs',   COUNT(*) FROM public.prescription_verification_logs
UNION ALL SELECT 'consultation_anamnesis',           COUNT(*) FROM public.consultation_anamnesis
UNION ALL SELECT 'encounters',                       COUNT(*) FROM public.encounters
UNION ALL SELECT 'medical_documents',                COUNT(*) FROM public.medical_documents
UNION ALL SELECT 'video_rooms',                      COUNT(*) FROM public.video_rooms
UNION ALL SELECT 'ai_interaction_logs',              COUNT(*) FROM public.ai_interaction_logs
UNION ALL SELECT 'ai_suggestions',                   COUNT(*) FROM public.ai_suggestions
UNION ALL SELECT 'document_access_log',              COUNT(*) FROM public.document_access_log
UNION ALL SELECT 'notifications',                    COUNT(*) FROM public.notifications
UNION ALL SELECT 'payments',                         COUNT(*) FROM public.payments
UNION ALL SELECT 'payment_attempts',                 COUNT(*) FROM public.payment_attempts
ORDER BY tabela;

\echo ''
\echo '=== 10) USERS intactos? ==='
SELECT 'users' AS tabela, COUNT(*) FROM public.users
UNION ALL SELECT 'patients',            COUNT(*) FROM public.patients
UNION ALL SELECT 'doctor_profiles',     COUNT(*) FROM public.doctor_profiles
UNION ALL SELECT 'doctor_certificates', COUNT(*) FROM public.doctor_certificates;

\echo ''
\echo '=== COMMIT ==='
COMMIT;
