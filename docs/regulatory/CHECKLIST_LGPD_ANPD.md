# Checklist LGPD / ANPD — RenoveJá Public Service

**Data-base:** 26/08/2026  
**Escopo:** tratamento de dados pessoais e dados sensíveis de saúde no RenoveJá+ / Public Service.

> Status neste checklist significa **evidência verificável no repositório**. Contrato com operador,
> configuração de nuvem ou homologação externa só recebem ✅ quando houver prova correspondente.

## 1. Governança e base legal

| Item | Status | Evidência/ação |
|---|---|---|
| Finalidades assistenciais documentadas | ✅ | RIPD + ROPA |
| Dados de saúde classificados como sensíveis | ✅ | RIPD/ROPA/políticas |
| Bases legais por fluxo | 🟠 | documentadas em alto nível; validar por contrato/ente e finalidade específica |
| ROPA | ✅ | `ROPA_LGPD_RENOVEJA.md` v1.2 |
| RIPD | ✅ | `RIPD_RENOVEJA.md` v1.2 |
| Inventário de dados | ✅/🟠 | documento existente; revisar a cada integração/operador novo |
| Revisão periódica formal | 🟠 | precisa de calendário/evidência organizacional |

## 2. Encarregado / DPO

| Item | Status | Evidência |
|---|---|---|
| Ato formal de nomeação | ✅ | `DPO_NOMEACAO_PUBLICACAO.md` |
| Identidade pública coerente com o ato | ✅ | `PublicPrivacy.tsx` reconciliado em 26/08/2026 |
| Canal público | ✅ | `privacidade@renovejasaude.com.br` e canais oficiais |
| Independência/segregação de função | 🟠 | Encarregado interino acumula função administrativa; decisões de alto impacto devem buscar revisão independente |

## 3. Transparência ao titular

| Item | Status | Evidência/ação |
|---|---|---|
| Política pública web | ✅ | `/privacidade` |
| Operadores principais informados | ✅ | OpenAI, Google/Gemini, Daily/Deepgram, AWS e integrações públicas quando aplicáveis |
| Transferência internacional explicada sem promessa não comprovada | ✅ | política pública revisada em 26/08/2026 |
| Direitos do titular e canal | ✅ | política pública |
| Nova finalidade/material change exige revisão | ✅ documental | manter processo operacional |

## 4. Operadores, suboperadores e transferência internacional

| Operador | Papel técnico | Evidência contratual no repo | Status |
|---|---|---|---|
| AWS | infraestrutura | não auditada neste checklist | 🟠 |
| OpenAI | IA/LLM/transcrição conforme configuração | DPA/addendum não localizado fora de mera menção documental | 🟠 |
| Google/Gemini | fallback/segunda opinião de IA | DPA/addendum não localizado | 🟠 |
| Daily.co | vídeo/transcrição | DPA/termos precisam ser anexados ao dossiê | 🟠 |
| Deepgram | suboperador via Daily | confirmar cobertura no contrato/DPA do Daily | 🟠 |
| InfoSimples | validação de CRM quando habilitada | revisar termos/DPA | 🟠 |
| Twilio | WhatsApp quando habilitado | revisar termos/DPA | 🟠 |

**Regra:** link público para um DPA padrão não prova que a RenoveJá aderiu/assinou o instrumento aplicável. Guardar a evidência contratual no dossiê de compliance.

## 5. Segurança técnica

| Controle | Status | Observação |
|---|---|---|
| HTTPS/TLS | ✅ desenho | comprovar endpoint da release/ambiente |
| Criptografia em repouso | ✅ desenho | comprovar configuração do ambiente |
| Segredos fora do código | ✅ desenho | SSM/KMS e variáveis protegidas |
| RBAC | ✅ | global + `institution_memberships`/permissões públicas |
| MFA `doctor` | ✅ | obrigatório em produção |
| MFA `admin` | ✅ | obrigatório em produção |
| MFA `sus` | ✅ | obrigatório em produção; cobre usuários institucionais |
| Auditoria | ✅ | logs/eventos/receipts nos fluxos cobertos |
| RLS policies | ✅ código/teste | policies e preflight versionados |
| RLS enforcement no banco alvo | 🟠 | executar workflow manual + teste cross-tenant; não presumir ativo |
| Rate limiting | ✅ | políticas por endpoint |
| Retenção clínica protegida | ✅ código | regras/triggers nos objetos abrangidos |
| Alarmes/on-call efetivamente ativos | 🟠 | IaC não equivale a aplicação no ambiente |

## 6. IA e dados sensíveis

| Controle | Status | Evidência |
|---|---|---|
| IA como apoio, não autoridade final | ✅ | `GOVERNANCA_IA_CFM_2454_2026.md` + código |
| PII minimizada antes do LLM nos fluxos cobertos | ✅ | `PromptSanitizer` |
| Revisão humana antes de documento clínico | ✅ | `PrescriptionReviewGate` |
| Trilha de geração/decisão | ✅ | `AiSuggestionTrail` |
| Hash/receipt para evidência sem depender de conteúdo bruto | ✅ | trilhas/evidence patterns |
| Mudança de modelo/provedor governada | ✅ documental | executar processo antes de promoção |
| DPA/transferência internacional | 🟠 | pendência contratual externa |

## 7. Continuidade assistencial e receita

| Controle | Status | Evidência |
|---|---|---|
| Paciente crônico / janela de 180 dias | ✅ código | advisor + bloqueio backend na aprovação de receita |
| Registro institucional de presencialidade | ✅ código | endpoint `presential-care` + `encounters.is_presential='true'` |
| Paciente não pode autoafirmar presencialidade | ✅ | endpoint somente `sus,admin` + `clinical.write` |
| Controlados/SNCR sem integração oficial | ✅ fail-closed | `SncrElectronicPrescriptionGate` |
| Liberação real SNCR | 🔴 externa | aguarda serviço oficial + integração/homologação |

## 8. Incidentes e resposta

| Item | Status | Ação |
|---|---|---|
| Plano de resposta | ✅ documento | manter contatos e procedimentos atualizados |
| Trilha forense | ✅ | audit logs/events |
| Canal de notificação técnica | 🟠 | comprovar alarmes/SNS/canal operacional no ambiente |
| Simulado periódico | 🟠 | executar e guardar ata/evidência |
| Critério de comunicação ANPD/titulares | ✅ documental | aplicar avaliação de risco no incidente real |

## 9. Interoperabilidade pública

| Item | Status | Observação |
|---|---|---|
| SOA-CNES/SIGTAP | ✅ código | validar acesso/ambiente |
| RNDS/e-SUS | 🟠 | adapters/estrutura existem; credenciais e homologação são externas |
| Controle externo/reidentificação | ✅ código | exige permissão específica e auditoria; usar minimização sempre que possível |
| SNCR | 🔴 operacional | bloqueado até integração oficial disponível/homologada |

## 10. Pendências antes de apresentar “conformidade completa”

- [ ] anexar/comprovar DPAs e instrumentos de transferência internacional aplicáveis;
- [ ] executar e comprovar RLS no banco alvo + teste cross-tenant;
- [ ] comprovar alarmes/notificações do ambiente;
- [ ] executar simulado de incidente;
- [ ] validar PDF real da release no Validar ITI;
- [ ] concluir homologações públicas externas exigidas pelo contrato;
- [ ] executar os gates de CI/release no mesmo SHA de produção.

## 11. Referências internas

- `RIPD_RENOVEJA.md`
- `ROPA_LGPD_RENOVEJA.md`
- `DPO_NOMEACAO_PUBLICACAO.md`
- `GOVERNANCA_IA_CFM_2454_2026.md`
- `MATRIZ_NGS2_SRES.md`
- `../public-sector/SNCR_ANVISA_READINESS.md`
- `../public-sector/GO_LIVE_PUBLIC_SERVICE.md`
- `../security/ROW_LEVEL_SECURITY.md`

**Semântica:** `IMPLEMENTADO != CONFIGURADO != AUTORIZADO != HOMOLOGADO != PRODUÇÃO`.
