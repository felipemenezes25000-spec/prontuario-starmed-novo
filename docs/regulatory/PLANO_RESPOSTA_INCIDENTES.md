# Plano de resposta a incidentes de segurança

**Referência:** LGPD art. 48, ANPD. Detecção, contenção, notificação e comunicação.

---

## 1. Definições

- **Incidente:** Evento que cause ou possa causar risco aos titulares (ex.: vazamento, acesso não autorizado, perda de dados).
- **Responsável:** Equipe técnica + DPO (Encarregado de Proteção de Dados).
- **Canal de contato:** (11) 98631-8000 · www.renovejasaude.com.br (conforme `frontend-mobile/lib/company.ts`).

---

## 2. Etapas de resposta

### 2.1 Detecção

- Monitorar logs de auditoria (`audit_logs`), tentativas de verificação (`prescription_verification_logs`), webhooks.
- Alertas: falhas de autenticação em massa, acessos anômalos, erros de storage.
- Fonte: AWS CloudWatch (API, ECS), alertas manuais.

### 2.2 Contenção

- Isolar sistemas afetados (ex.: revogar tokens, bloquear IP).
- Preservar evidências (logs, snapshots) para análise.
- Comunicar internamente (equipe técnica, gestão).

### 2.3 Análise

- Identificar escopo: quais dados, quantos titulares.
- Avaliar risco: probabilidade e gravidade (LGPD art. 48).
- Documentar: data, descrição, ações tomadas.

### 2.4 Notificação à ANPD

- **Quando:** Incidente que possa gerar risco relevante aos titulares (art. 48, §1º).
- **Prazo:** Em prazo razoável, definido pela ANPD (comunicado oficial).
- **Conteúdo:** Descrição da natureza dos dados, medidas técnicas e de segurança, riscos, motivos da demora (se houver), medidas adotadas para reverter ou mitigar.

### 2.5 Notificação aos titulares

- **Quando:** Risco relevante (art. 48, §2º).
- **Canal:** E-mail, notificação no app, ou outro meio de contato cadastrado.
- **Conteúdo:** Linguagem clara; natureza do incidente; dados afetados; medidas adotadas; orientações (ex.: trocar senha).

### 2.6 Comunicação interna

- Registrar incidente em documento interno (data, escopo, ações, notificações).
- Revisar processos para evitar recorrência.

---

## 3. Contatos de emergência

| Papel | Contato |
|-------|---------|
| DPO / Proteção de dados | (11) 98631-8000 · www.renovejasaude.com.br |
| Equipe técnica | [definir] |
| ANPD | https://www.gov.br/anpd |

---

## 4. Checklist pós-incidente

- [ ] Contenção aplicada
- [ ] Evidências preservadas
- [ ] Análise de escopo concluída
- [ ] Notificação à ANPD (se aplicável)
- [ ] Notificação aos titulares (se aplicável)
- [ ] Registro interno atualizado
- [ ] Revisão de processos
