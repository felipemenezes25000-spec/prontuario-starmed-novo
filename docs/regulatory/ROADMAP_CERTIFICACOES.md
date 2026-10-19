# Roadmap de Certificações e Maturidade de Segurança — RenoveJá+

**Versão:** 1.0  
**Data:** 13 de abril de 2026  
**Classificação:** Documento Estratégico  
**Responsável:** Felipe Menezes — CTO / Fundador

---

## 1. Objetivo

Apresentar o plano evolutivo de certificações e maturidade de segurança da informação da plataforma RenoveJá+, demonstrando o compromisso com a proteção de dados de saúde e conformidade regulatória.

---

## 2. Estado Atual de Conformidade

### 2.1 Conformidades Ativas

| Requisito | Status | Evidência |
|-----------|--------|-----------|
| **LGPD** (Lei 13.709/2018) | **Em adequação** | RIPD, ROPA, DPO nomeado, Plano de Incidentes, Inventário de Dados, trilha de auditoria append-only. **Pendente:** DPA do Google/Gemini (operador de IA de *fallback*). A inclusão dele nas políticas de privacidade (web e app) foi feita em 22/08/2026 — [PENDENCIAS_TI.md §4.1](../PENDENCIAS_TI.md) |
| **CFM 2.314/2022** (Telemedicina) | Conforme | Assinatura ICP-Brasil; retenção clínica de 20 anos **imposta por trigger** no banco (`prevent_clinical_delete`) |
| **CFM 2.454/2026** (IA Médica) | Em adequação | IA como apoio; a decisão final é do médico **por construção** — nenhum documento é emitido sem a assinatura digital dele. Ainda **não medido**: aceite/override da sugestão ([PENDENCIAS_TI.md §7.3](../PENDENCIAS_TI.md)) |
| **ICP-Brasil** (Assinatura Digital) | ⚠️ **Escrito, inoperante** | Certificado **A1 (PFX)**, PAdES com OIDs de saúde, validação de cadeia por `IcpBrasilTrustStore`. Mas `infra/icp-brasil/roots/` contém **só um README, zero raízes de AC** → `TrustStoreNotConfigured` → **nenhum certificado de médico é aceito e nenhuma assinatura é produzida**. O carimbo do tempo passou de inexistente a **implementado e desligado**: há integração com a ACT SERPRO (credenciada ICP-Brasil), mas `TimestampProvider` chega vazio, `TimestampAuthorityUrl` vazia e `RequireTimestamp = false` no padrão, e nenhum documento foi emitido com carimbo. São **dois portões em série** e só um deles mudou. **Nenhum PDF deste código consta como validado no validar.iti.gov.br** |
| **Marco Civil da Internet** | **Parcial** | Trilha de acesso em `audit_logs` por 5 anos. O log de aplicação no CloudWatch retém **30 dias** — abaixo dos 6 meses do art. 15 |

> **Correções de 01/08/2026, todas por leitura do código:**
>
> - **"TISS"** saiu da linha do CFM 2.314. Não há integração TISS na plataforma —
>   nenhum endpoint, cliente ou mapeamento. A palavra estava lá sem lastro, e num
>   documento de licitação isso é o tipo de item que o avaliador pede para
>   demonstrar.
> - **"A1/A3"** virou **A1**. O fluxo de assinatura carrega um `.pfx` com senha
>   (certificado A1). A3 é token/cartão físico, que exigiria middleware PKCS#11 no
>   cliente — não existe.
> - **LGPD "Conforme"** virou "Em adequação", pelo motivo na própria linha.
> - **Marco Civil "Conforme"** virou "Parcial": a retenção de log de aplicação é
>   de 30 dias (`infra/ecs.tf`), e o art. 15 fala em 6 meses.
>
> **Correção de 22/08/2026 — ICP-Brasil deixou de ser "Implementado".** A linha
> dizia "cadeia validada, aceito pelo validar.iti.gov.br". O código está lá e
> falha fechado corretamente, mas o trust store chega **vazio** ao container
> (`infra/icp-brasil/roots/` só tem `README.md`), o que torna a assinatura
> qualificada **inoperante**: nenhum certificado de médico pode sequer ser
> cadastrado. E não há, neste repositório, registro de nenhum documento gerado
> por este código submetido ao `validar.iti.gov.br` — a frase descrevia a
> intenção do desenho, não um resultado. Num edital, "aceito pelo validador do
> ITI" é exatamente o tipo de afirmação que o avaliador pede para demonstrar
> na hora. Ação e contexto no achado 2 de
> [`../security/AUDITORIA_OFENSIVA_2026-08-17.md`](../security/AUDITORIA_OFENSIVA_2026-08-17.md).

### 2.2 Políticas Documentadas

| Documento | Status |
|-----------|--------|
| Política de Privacidade (LGPD) | Documentada |
| RIPD (Relatório de Impacto) | Documentado |
| ROPA (Registro de Operações) | Documentado |
| Plano de Resposta a Incidentes | Documentado |
| SLA de Serviço | Documentado |
| Política de Controle de Acesso | Documentada |
| Política de Criptografia | Documentada |
| Política de Backup e Recuperação | Documentada |
| Threat Model (STRIDE) | Documentado |
| Security Handbook | Documentado |
| Inventário de Dados Pessoais | Documentado |
| Nomeação do DPO | Publicada |

### 2.3 Controles Técnicos Implementados

| Controle | Implementação | Onde roda |
|----------|--------------|-----------|
| Criptografia TLS (1.2 mínimo, 1.3 negociado) + AES-256 em repouso | AWS ACM + ALB + RDS + S3 | Infra |
| WAF (Web Application Firewall) | AWS WAFv2 com regras gerenciadas | Infra |
| SAST (Análise Estática) | Semgrep (OWASP + linguagem) | Hook `pre-push` local **e** job `sast` do `ci.yml` |
| Varredura de segredos | Gitleaks | Hooks `pre-commit`/`pre-push` locais **e** job `secrets` do `ci.yml` |
| Dependency Scanning | `npm audit` + `dotnet list package --vulnerable` | Hook `pre-push` local **e** job `raiz` do `ci.yml`, com baseline por pacote |
| IaC Scanning | Trivy sobre `infra/` | Hook `pre-push` local **e** job `iac` do `ci.yml` |
| RBAC | ASP.NET Authorization com `FallbackPolicy` fechada + `DoctorApprovalFilter` | Aplicação |
| Audit Logging | Middleware LGPD + `audit_logs`/`audit_events`, **append-only por trigger** | Aplicação + banco |
| Rate Limiting | 11 políticas nomeadas na aplicação + WAF | Aplicação + infra |
| Multi-AZ HA | ECS Fargate (subnets privadas nas 2 AZs) — ⚠️ **o RDS NÃO**: `multi_az = true` está no `database.tf` e `false` no state (ver [PENDENCIAS_TI §3.7](../PENDENCIAS_TI.md)) | Infra |
| DR documentado | RPO < 1h, RTO < 4h (**alvos — nunca cronometrados em exercício**) | Documento |

> ⚠️ **Duas correções que mudam a leitura desta tabela — 01/08/2026.**
>
> **1. "RBAC + RLS" perdeu o RLS — mas a redação de 01/08 ficou errada; corrigida
> em 17/08/2026.**
> A afirmação era que `grep -rn "ROW LEVEL SECURITY\|CREATE POLICY"` voltava
> vazio. Hoje o mesmo grep retorna **68 ocorrências em 8 arquivos** (1 de
> produção, 3 de teste, 4 SQL): `RlsWave1Migrations.cs` cria 14
> policies (10 em 17/08/2026 e 4 de leitura do controle externo em 21/08/2026)
> e sete funções, e `RlsWave1IntegrationTests` as prova
> contra PostgreSQL 15 real no CI.
>
> **O que continua verdadeiro é a conclusão, não a premissa:** as policies estão
> *staged* e **nenhuma tabela roda com `ENABLE ROW LEVEL SECURITY` em produção**.
> **Corrigido em 22/08/2026 — o motivo mudou:** o texto dizia "porque a
> aplicação ainda não propaga `renoveja.user_id` na transação", e isso deixou de
> ser verdade em 17/08/2026 — `PostgresClient.OpenConnectionAsync()` carimba o
> GUC em todo checkout do pool. O que falta é conferir precondições do ambiente
> alvo (`rls_activation_preflight`).
> O isolamento entre pacientes tem uma camada — o predicado de dono nas queries — e
> não duas. Para ISO 27001 A.9 e SOC 2 a formulação correta é **"controle
> projetado e verificado em teste, não implantado"**, não "controle inexistente".
> Ver [PENDENCIAS_TI.md §8.1](../PENDENCIAS_TI.md) e R-01 no
> [registro de risco](../engineering/RISK_REGISTER.md).
>
> **2. ~~Os scanners não rodam no CI~~ — resolvido em 17/08/2026.**
>
> O texto anterior deste item ("desde 16/08/2026 não há CI") descrevia a janela
> de um dia em que os workflows estiveram removidos. `ci.yml` voltou em
> 17/08/2026 e os scanners passaram a rodar no servidor:
>
> | Controle | Onde roda | Job |
> |---|---|---|
> | Segredo no histórico entrante | GitHub Actions | `secrets` (gitleaks 8.28.0, versão fixa) |
> | Dependência vulnerável | GitHub Actions | `raiz` (`deps:lint`, baseline em `security/`) |
> | IaC insegura | GitHub Actions | `iac` (trivy fixado por digest) |
> | Terraform inválido | GitHub Actions | `iac` (`terraform validate`) |
> | SAST | GitHub Actions | `sast` no `ci.yml` — Semgrep fixado por digest (OWASP Top 10, C#, TS, React, secrets) |
> | SAST (CodeQL) | GitHub Actions | `codeql.yml` — **desligado**: o job de análise depende de `vars.CODEQL_ENABLED == 'true'`, que não está definida |
> | Vulnerabilidade no build .NET | GitHub Actions | `backend` (NU1903/NU1904 reprovam) |
>
> **O que isso muda para este documento:** ISO 27001 A.8.28 e SOC 2 pedem
> *evidência* de que o controle rodou. Hook local não produzia evidência e era
> desarmável sem registro. Execução em Actions produz log datado, por commit,
> que o desenvolvedor não pode suprimir — que é a forma de evidência que auditor
> aceita.
>
> ⚠️ **Ressalva de 22/08/2026, que suspende o parágrafo acima na prática.**
> **Desde 21/08/2026 nenhum job do GitHub Actions chega a iniciar.** Os runs de
> `CI` e `CodeQL` na `main` terminam em falha em **4 a 9 segundos**, sem
> executar nenhuma etapa. Enquanto isso durar: (a) não há evidência de execução
> a apresentar para o período; (b) o único portão que roda de fato é o hook
> local de `pre-push`, com todas as fragilidades descritas acima; (c) o vermelho
> do Actions **não** indica regressão de código, e ler assim leva à conclusão
> errada. Este item volta a valer quando houver um run verde com etapas
> executadas.
>
> **O que ainda falta para a Fase 3, e é o ponto honesto:**
>
> 1. O `CI` **não está marcado como required status check** no repositório. Sem
>    isso o portão reprova mas não bloqueia o merge — o log existe, a barreira
>    não. Recomendação em
>    [engineering/BRANCH_PROTECTION.md](../engineering/BRANCH_PROTECTION.md);
>    aplicar é decisão de quem administra o repositório.
> 2. Retenção de log do Actions é a padrão do GitHub (90 dias), não uma política
>    de retenção de evidência definida.
> 3. ~~Não se gera SBOM nem inventário de licenças, e a imagem de container não
>    é varrida.~~ **Errado desde 17/08/2026 — corrigido nesta revisão.** Existe
>    `scripts/security/generate-sbom.mjs`, que emite **CycloneDX 1.5** cobrindo
>    npm (raiz, web, mobile) e NuGet, com hash SHA-512 e licença declarada por
>    pacote — 1.764 componentes, 1.746 com licença, na execução de 17/08/2026. Ele
>    roda como *smoke* a cada push (job `raiz`) e completo em `supply-chain.yml`,
>    com artefato retido 90 dias. A imagem de container **é** varrida por Trivy no
>    mesmo workflow. O risco R-18 do
>    [registro de risco](../engineering/RISK_REGISTER.md) está fechado.
>
>    **O que continua aberto, e é outra coisa:** (a) o scan de imagem é
>    *evidência*, não *gate* — o job não converte HIGH/CRITICAL em falha e não
>    roda em pull request; os 84 achados de 17/08/2026 (73 HIGH + 11 CRITICAL)
>    não têm triagem nem baseline; (b) o SBOM não é assinado — não há cosign,
>    SLSA provenance ou in-toto no repositório; (c) o próprio gerador declara que
>    inventário técnico de licença **não substitui análise jurídica de
>    compatibilidade**, o que mantém o R-06 aberto.
>
> Registrado em [PENDENCIAS_TI.md §8.2](../PENDENCIAS_TI.md) e na quinta passada
> do mesmo documento.

---

## 3. Roadmap de Certificações

> ⚠️ **Situação do cronograma em 01/08/2026: a Fase 1 está atrasada.** Os prazos
> abaixo foram escritos em abril e nunca revisados. Maio e junho passaram; nenhum
> pen-test — automatizado ou externo — foi executado. Isso empurra a Fase 2 e,
> por dependência, a Fase 3.
>
> A coluna "Situação" foi acrescentada em vez de reescrever as datas: **a data
> original é a informação que importa** para quem avalia se o fornecedor cumpre
> compromisso. Apagar o atraso é o que transformaria este roadmap em folheto.

### Fase 1 — Fundação (Q2 2026) `ATRASADA`

**Objetivo:** Completar documentação formal e realizar primeiro teste de segurança.

| Ação | Prazo | Situação em 01/08/2026 | Investimento Estimado |
|------|-------|------------------------|----------------------|
| Documentar todas as políticas de segurança | Abril 2026 | ✅ Concluído (e revisado contra o código em 01/08/2026) | Interno |
| Realizar pen-test automatizado (OWASP ZAP) | Maio 2026 | ⚠️ **Vencido, não executado** | Interno |
| Remediar findings CRÍTICOS e ALTOS | Maio 2026 | 🔶 Parcial — remediados os do scan interno de 04/2026 e os da auditoria de 01/08/2026 (commit `140caf48`); mas não há pen-test cujos findings remediar | Interno |
| Contratar pen-test externo (empresa credenciada) | Junho 2026 | ⚠️ **Vencido, não contratado** | R$ 8.000 – 15.000 |
| Gerar relatório formal de pen-test | Junho 2026 | ⚠️ Bloqueado pelo anterior | Incluso no pen-test |

### Fase 2 — Pen-Test e Remediação (Q3 2026) `EM RISCO`

> Depende inteiramente da contratação prevista para junho, que não aconteceu.
> Julho de 2026 já passou sem o pen-test externo.

**Objetivo:** Ter relatório de pen-test externo e remediar todas as vulnerabilidades encontradas.

| Ação | Prazo | Status | Investimento Estimado |
|------|-------|--------|----------------------|
| Executar pen-test externo (black-box + gray-box) | Julho 2026 | Planejado | Incluso na Fase 1 |
| Remediar findings do pen-test externo | Agosto 2026 | Planejado | Interno |
| Re-test de validação | Agosto 2026 | Planejado | R$ 3.000 – 5.000 |
| Publicar relatório executivo de segurança | Setembro 2026 | Planejado | Interno |
| Implementar DAST contínuo no CI/CD | Setembro 2026 | Planejado | Interno |

### Fase 3 — ISO 27001 (Q4 2026 – Q2 2027)

**Objetivo:** Obter certificação ISO 27001:2022 (Sistema de Gestão de Segurança da Informação).

| Ação | Prazo | Status | Investimento Estimado |
|------|-------|--------|----------------------|
| Gap analysis ISO 27001 | Outubro 2026 | Planejado | R$ 10.000 – 20.000 |
| Implementar controles faltantes (Anexo A) | Nov-Dez 2026 | Planejado | Interno + consultoria |
| Auditoria interna (mock) | Janeiro 2027 | Planejado | R$ 5.000 – 10.000 |
| Auditoria externa (Fase 1 — documentação) | Fevereiro 2027 | Planejado | R$ 15.000 – 25.000 |
| Auditoria externa (Fase 2 — implementação) | Abril 2027 | Planejado | Incluso na Fase 1 |
| **Certificação ISO 27001** | **Maio 2027** | Planejado | Total: R$ 30.000 – 55.000 |

### Fase 4 — SOC 2 Type I (Q3 2027)

**Objetivo:** Obter relatório SOC 2 Type I (Trust Service Criteria: Security, Availability, Confidentiality).

| Ação | Prazo | Status | Investimento Estimado |
|------|-------|--------|----------------------|
| Preparação SOC 2 (policies, evidence) | Junho 2027 | Planejado | Interno + consultoria |
| Auditoria SOC 2 Type I | Agosto 2027 | Planejado | R$ 25.000 – 40.000 |
| **Relatório SOC 2 Type I** | **Setembro 2027** | Planejado | Incluso na auditoria |

### Fase 5 — Maturidade Contínua (2027+)

| Ação | Prazo | Investimento Estimado |
|------|-------|----------------------|
| SOC 2 Type II (12 meses de evidência) | 2028 | R$ 30.000 – 50.000 |
| ISO 27701 (Privacidade — extensão da 27001) | 2028 | R$ 15.000 – 25.000 |
| SBIS/CFM Certificação de S-RES (se aplicável) | 2028 | A avaliar |
| Bug Bounty Program | 2028+ | Variável |

---

## 4. Investimento Consolidado

| Fase | Período | Investimento |
|------|---------|-------------|
| Fase 1 — Fundação | Q2 2026 | R$ 8.000 – 15.000 |
| Fase 2 — Pen-Test | Q3 2026 | R$ 3.000 – 5.000 |
| Fase 3 — ISO 27001 | Q4 2026 – Q2 2027 | R$ 30.000 – 55.000 |
| Fase 4 — SOC 2 Type I | Q3 2027 | R$ 25.000 – 40.000 |
| Fase 5 — Maturidade | 2028+ | R$ 45.000 – 75.000 |
| **Total estimado (até SOC 2 Type I)** | | **R$ 66.000 – 115.000** |

---

## 5. Priorização para Municípios

Para municípios que exigem evidências de segurança **imediatas**, a RenoveJá+ pode apresentar:

### Disponível agora (revisado em 01/08/2026)

Todos os itens abaixo existem no repositório e foram **reconferidos contra o
código** nesta data — não são apenas títulos de arquivo:

1. **SLA formal**, com a distinção explícita entre o que é medido e o que é alvo
2. **Política de Privacidade (LGPD)** com RIPD, ROPA, DPO nomeado
3. **Plano de Resposta a Incidentes** (LGPD e operacional)
4. **Política de Controle de Acesso** (RBAC, autenticação, auditoria)
5. **Política de Criptografia** (TLS, AES-256-GCM, bcrypt)
6. **Política de Backup e Recuperação** (RPO < 1h; RTO < 4h como alvo)
7. **Threat Model (STRIDE)** com análise de 12 cenários
8. **Security Handbook** com mapeamento OWASP Top 10
9. **Relatório de Scan de Segurança Interno** (15 findings analisados)
10. **Relatório de auditoria profunda de 01/08/2026** — 118 achados em 10
    dimensões, com o que era corrigível em código já aplicado (commit
    `140caf48`) e o restante registrado em `docs/PENDENCIAS_TI.md` com
    prioridade e esforço

> **O item 10 é o mais forte desta lista para um avaliador**, e não estava aqui:
> mostra achado, correção e pendência assumida com prazo. Vale mais que uma
> política sem evidência de execução.

### Ainda não disponível — **atrasado**

11. **Relatório de Pen-Test Externo** por empresa credenciada — previsto para
    julho de 2026, **não realizado**; a contratação (junho) não ocorreu
12. **Evidência de remediação** de vulnerabilidades de pen-test — bloqueado pelo
    item 11

> Se o edital exigir pen-test externo como critério de habilitação, **este é hoje
> o item bloqueante**, e o prazo realista passa a contar da contratação, não desta
> data. Municípios como Jundiaí já exigem essa evidência.

### Disponível em 12 meses, se a Fase 1 destravar

13. **Certificação ISO 27001:2022** — a data de Q2 2027 pressupunha o pen-test
    em Q3 2026. Recalcular a partir da contratação efetiva

---

## 6. Benchmarking

| Indicador | RenoveJá+ (Atual) | Média de Startups SaaS BR |
|-----------|-------------------|--------------------------|
| Políticas documentadas | 12+ documentos, revisados contra o código | 2-3 documentos |
| LGPD | Estrutura completa (DPO, RIPD, ROPA, inventário, trilha imutável); pendente o DPA do Gemini | Parcial |
| SAST + segredos + IaC | Sim (Semgrep, Gitleaks, Trivy) — em hook local **e** em jobs do `ci.yml` desde 17/08/2026; ⚠️ o Actions **não executa desde 21/08/2026** | Raro |
| DAST | **Configurado, nunca executado** — `.github/workflows/stackhawk.yml` + `stackhawk.yml` existem desde 17/08/2026, mas o job de scan depende de `vars.STACKHAWK_ENABLED == 'true'`, que não está definida, e exige um staging que não existe | Raro |
| WAF | Sim (AWS WAFv2) | Raro |
| Multi-AZ HA | **Parcial** — ECS sim, RDS não (declarado, não aplicado) | Incomum |
| DR documentado | Sim (RPO < 1h, RTO < 4h) — **procedimento nunca exercitado** | Raro |
| Pen-test externo | **Atrasado** (previsto Q3 2026, não contratado) | Raro |
| ISO 27001 | Planejado (Q2 2027, a recalcular) | Muito raro |

> Correções de 01/08/2026: "SAST/DAST no CI: Sim" eram duas afirmações falsas
> numa linha só — os scanners não rodavam no CI, e DAST não existia em lugar
> nenhum. A comparação com o mercado continua favorável **sem** esses dois
> itens; não havia razão para inflá-la.
>
> Atualização de 22/08/2026: a parte do SAST **deixou de ser falsa** em
> 17/08/2026, com a volta do `ci.yml`. A do DAST continua valendo — existe
> `stackhawk.yml` no repositório, com gatilho manual e agendamento semanal, mas
> ele não roda enquanto o Actions estiver parado, e este documento não tem
> evidência de nenhuma execução.

---

## 7. Responsáveis

| Papel | Nome | Responsabilidade |
|-------|------|-----------------|
| CTO / Fundador | Felipe Menezes | Liderança técnica, implementação de controles, coordenação de auditorias |
| DPO (Encarregado) | Felipe Menezes da Silva de Oliveira — **interino** | Conformidade LGPD, comunicação com ANPD, gestão de incidentes de privacidade |

> **Correção de 17/08/2026.** Esta tabela nomeava outra pessoa como DPO,
> divergindo do documento formal de nomeação
> ([DPO_NOMEACAO_PUBLICACAO.md](DPO_NOMEACAO_PUBLICACAO.md)) e do
> [RIPD](RIPD_RENOVEJA.md), que apontam Felipe Menezes da Silva de Oliveira como
> Encarregado **interino**. Prevalece o instrumento de nomeação, que é o de maior
> peso jurídico. Dois nomes de DPO em documentos do mesmo diretório é achado de
> auditoria por si só.
>
> **Risco declarado, não resolvido pela correção:** no RIPD, elaborador, DPO e
> aprovador da direção são a **mesma pessoa**. Isso enfraquece a independência
> que o art. 41 da LGPD pressupõe e agrava o R-02 (bus factor) do
> [registro de risco](../engineering/RISK_REGISTER.md). A designação de um
> Encarregado efetivo e independente continua pendente.

---

**Próxima revisão:** ao contratar o pen-test externo, **ou** em outubro de 2026 —
o que vier primeiro. A marcação anterior era "julho de 2026 (após pen-test
externo)" e ficou presa, porque o gatilho não aconteceu e não havia data
alternativa. Revisão de documento de licitação não deve depender só de um evento
que pode não ocorrer.

---

*RenoveJá Saúde Digital LTDA*  
*Este documento é confidencial e destinado exclusivamente a fins de conformidade e licitação.*
