# Política de Backup e Recuperação de Desastres — RenoveJá+

**Versão:** 1.0  
**Data:** 13 de abril de 2026  
**Classificação:** Documento Formal  
**Responsável:** Felipe Menezes — CTO / Fundador  
**Referência:** ISO 27001:2022 — Anexo A.12.3 (Backup)

---

## 1. Objetivo

Definir os procedimentos de backup, retenção e recuperação de dados da plataforma RenoveJá+, garantindo a disponibilidade e integridade das informações em caso de falhas, desastres ou incidentes de segurança.

---

## 2. Escopo

| Componente | Incluso |
|------------|---------|
| Banco de dados (RDS PostgreSQL) | Sim |
| Armazenamento de objetos (S3) | Sim |
| Configurações de infraestrutura (Terraform) | Sim |
| Código-fonte (GitHub) | Sim |
| Cache (Redis) | Não (reconstruído a partir do banco) |
| Logs de aplicação (CloudWatch) | Parcial (retenção nativa) |

---

## 3. Objetivos de Recuperação

| Métrica | Alvo | Justificativa |
|---------|------|---------------|
| **RPO** (Recovery Point Objective) | < 1 hora | WAL archiving do PostgreSQL permite PITR |
| **RTO** (Recovery Time Objective) | < 4 horas | Tempo para restaurar banco + validar integridade + reiniciar serviços |

---

## 4. Estratégia de Backup

### 4.1 Banco de Dados (RDS PostgreSQL)

| Parâmetro | Valor |
|-----------|-------|
| **Tipo** | Snapshot automático diário + WAL contínuo |
| **Frequência** | Diária (automática AWS) |
| **Retenção** | ⚠️ **Prometido 30 dias; a instância está em 14.** Conferido em 19/09/2026 por `describe-db-instances`. Os 30 dias são compromisso com o Campo Novo, travado por `scripts/__tests__/campo-novo-infra-ha.test.mjs`, e o `infra/database.tf` continua declarando 30 de propósito — rebaixar o arquivo para 14 faria o contrato de teste passar mentindo. Fechar é operação online, sem downtime nem reinício: `aws rds modify-db-instance --db-instance-identifier renoveja-postgres --backup-retention-period 30 --apply-immediately`. Custo: só armazenamento de snapshot acima dos 20 GB do banco. **Obrigação não cumprida, pendente de decisão** |
| **PITR (Point-in-Time Recovery)** | Habilitado — restauração a qualquer segundo dentro da janela. Hoje a janela real é de **14 dias**, não 30 (ver acima) |
| **Multi-AZ** | ❌ **NÃO ATIVO.** Evidência runtime de 19/09/2026: `describe-db-instances` → `MultiAZ: false`, AZ única `sa-east-1b`. É a evidência que a matriz do contrato (`CAMPO_NOVO_008_2026_GOLDEN_CONTRACT_MATRIX.md`, linha *Infra / disponibilidade*, **Parcial**) pedia — "configuração declarada não prova recurso rodando". O `database.tf` mantém `multi_az = true` porque é a promessa contratual, não porque esteja aplicado. Cumprir custa US$ 201/mês on-demand ou US$ 124/mês com reserva de 1 ano. O risco concreto de não cumprir é queda de AZ inteira virar indisponibilidade até restore manual (30-60 min pelo runbook), **não** perda de prontuário — isso é coberto por backup + PITR + deletion protection. Ver §4.1.1 |
| **Criptografia** | AES-256 (inclui snapshots e réplicas) |

#### 4.1.1 ⚠️ Correção do Multi-AZ — 01/08/2026, terceira passada

A revisão anterior deste documento, do mesmo dia, escreveu "Multi-AZ: Ativo".
Era falso. O erro tem uma causa específica e vale registrar: ela conferiu o
**código** e não conferiu o **state**.

| Fonte | O que diz | Quando |
|---|---|---|
| `infra/database.tf` | `multi_az = true` | commit `6da0c7ba`, 09/04/2026 |
| `infra/terraform.tfstate` (serial 162) | `"multi_az": false`, `availability_zone: "sa-east-1b"`, sem AZ secundária | 21/04/2026 — **depois** do commit |

Ou seja: o atributo foi escrito, o Terraform passou por ali depois, e a mudança
não pegou.

**Consequência para esta política:** o cenário 5.1 abaixo prevê "failover
automático Multi-AZ em 60-120 segundos" como etapa 2. **Essa etapa não vai
acontecer.** Numa falha de AZ, o procedimento real começa direto na etapa 4
(PITR/restore manual), com o tempo correspondente.

Confirme contra a AWS antes de agir — o state é de abril:

```bash
aws rds describe-db-instances --region sa-east-1 \
  --db-instance-identifier renoveja-postgres \
  --query "DBInstances[0].{MultiAZ:MultiAZ,SecondaryAZ:SecondaryAvailabilityZone}"
```

Ligar (ou assumir single-AZ por escrito):
[`docs/ACOES_PENDENTES_AWS.md`](../ACOES_PENDENTES_AWS.md) ação 6.

### 4.2 Armazenamento de Objetos (S3)

Nomes conferidos contra `infra/storage.tf` em 01/08/2026 — o bucket
`renoveja-documents` que este documento citava **não existe**; os documentos
clínicos vivem em `renoveja-prescriptions`.

| Bucket | Versionamento | Conteúdo / retenção |
|--------|--------------|---------------------|
| `renoveja-prescriptions` | Ativo | Receitas, exames, atestados assinados — 20 anos (CFM 1.821/2007) |
| `renoveja-certificates` | Ativo | Certificados PFX dos médicos, cifrados em AES-256-GCM |
| `renoveja-transcripts` | Ativo | Transcrições de teleconsulta (compõem o prontuário) |
| `renoveja-avatars` | Ativo | Fotos de perfil |
| `renoveja-frontend-web` | Ativo | Assets do portal web |

> **Correção de 22/08/2026:** a linha `renoveja-rh-web` saiu desta tabela. O
> portal RH foi removido do produto em 17/08/2026 (commit `152f8565`) e o
> `infra/cdn-rh.tf` que a linha citava **não existe mais** no repositório — logo
> não há mais o que versionar nem o que restaurar por aqui. Se o bucket
> permanece na conta AWS, virou recurso órfão, fora do Terraform, e deve entrar
> na fila de limpeza e não na de backup.

### 4.3 Código-Fonte (GitHub)

| Parâmetro | Valor |
|-----------|-------|
| Repositório | Privado |
| Histórico | Completo (git history), com cópia em dois remotes |
| Branches | **Só `main`.** Não há `develop` e não há branch protection |
| CI/CD | **Existe, e desde 21/08/2026 não executa.** Corrigido em 22/08/2026 — o texto anterior dizia "Não há, removido em 16/08/2026, restam dois workflows manuais". `ci.yml` voltou em 17/08/2026 e `.github/workflows/` tem hoje 11 workflows. Porém, **desde 21/08/2026 nenhum job do GitHub Actions inicia**: `CI` e `CodeQL` falham em 4-9 s sem rodar etapa alguma. Na prática o portão real continua sendo o hook local de `pre-push`. O deploy **não** sai de push na `main`: `deploy-aws.yml` só dispara por `workflow_dispatch` |

> ⚠️ **Correções de 01/08/2026.** Este bloco afirmava "branch protection em
> `main`" e "branches protegidos: `main`, `develop`". Nenhuma das duas coisas é
> verdade: `git branch -a` lista apenas `main` (fora as worktrees de agente), e
> não há regra de proteção configurada.
>
> Do ponto de vista de **backup**, que é o objeto deste documento, o que importa
> continua valendo: o histórico completo existe e está replicado em mais de um
> remote, então perda da máquina do desenvolvedor não perde código. O que não
> existe é o controle de *processo* (revisão obrigatória) — que é outro assunto,
> tratado no item 6.1 de [PENDENCIAS_TI.md](../PENDENCIAS_TI.md).

### 4.4 Infraestrutura como Código (Terraform)

| Parâmetro | Valor |
|-----------|-------|
| Definição da infra (`*.tf`) | Versionada no Git, junto ao código |
| **State** | ⚠️ **Local** — `infra/terraform.tfstate`, na máquina de quem aplica. Sem backend remoto e sem *lock* |
| Reprodutibilidade | A infraestrutura é descrita por inteiro em `infra/*.tf` e pode ser recriada via `terraform apply` |

> ⚠️ **Correção de 01/08/2026: o state NÃO está em backend remoto.**
> `infra/main.tf` tem `required_version` e `required_providers`, e **nenhum bloco
> `backend`**. O state fica em disco local e está no `.gitignore` — corretamente,
> porque state do Terraform carrega segredo em texto plano, mas isso significa que
> **existe uma única cópia dele e ela não é versionada nem replicada**.
>
> **Por que isso é um problema de backup, e não de higiene:** perder essa máquina
> não derruba a produção, mas deixa a infraestrutura órfã do Terraform — sem
> `plan`, sem `apply`, sem `destroy`, até reimportar recurso a recurso. Combinado
> com bus factor 1 (item 6.1), é o ativo mais frágil do inventário desta política.
> Correção: `backend "s3"` com bucket versionado + `dynamodb_table` para lock, e
> `terraform init -migrate-state`. Registrado em
> [PENDENCIAS_TI.md §3.6](../PENDENCIAS_TI.md), agravado de P3 para P2.

---

## 5. Procedimentos de Recuperação

> ✅ **O alerta automático passou a disparar em 19/09/2026.**
> Os alarmes de banco existem e avisam: `renoveja-rds-cpu-high`,
> `renoveja-rds-connections-high` e `renoveja-rds-storage-low`, todos apontando para o
> tópico `renoveja-alerts`, com assinatura de e-mail confirmada.
>
> **Correção de nome:** `renoveja-ecs-zero-tasks` nunca existiu na AWS, e o
> `renoveja-ecs-task-failures` que existia ficou em ALARM **falso** de 24/04 a 19/09/2026
> (lia uma métrica do Container Insights, que está desligado no cluster). Quem cobre essa
> função hoje é **`renoveja-api-no-healthy-targets`**, que mede o outro lado da corrente:
> capacidade real atendendo atrás do ALB. Cite esse nome nos procedimentos.
>
> Os alarmes foram criados por CLI, não por `terraform apply` — o apply segue congelado, e
> o `cloudwatch-alarms.tf` descreve um conjunto diferente do que está no ar.

### 5.1 Cenário: Falha no Banco de Dados

| Etapa | Ação | Responsável | Tempo Estimado |
|-------|------|-------------|----------------|
| 1 | Alerta automático (CloudWatch `renoveja-rds-*`) | Sistema | ✅ **Dispara desde 19/09/2026** — `renoveja-rds-cpu-high`, `renoveja-rds-connections-high` e `renoveja-rds-storage-low` publicam em `renoveja-alerts`, com e-mail confirmado. Criados por CLI (o apply segue congelado) |
| 2 | ~~Failover automático Multi-AZ~~ | ~~AWS RDS~~ | ❌ **Não acontece** — Multi-AZ não está aplicado (§4.1.1). Pule para a etapa 4 |
| 3 | Verificar conectividade da API (`/api/health/live`) | CTO | 5 minutos |
| 4 | Iniciar PITR/restore manual (**hoje esta é a etapa 2 de fato**) | CTO | 30-60 minutos |
| 5 | Validar integridade dos dados restaurados | CTO | 30 minutos |
| 6 | Atualizar connection string se necessário | CTO | 15 minutos |
| 7 | Registrar incidente e causa-raiz | CTO + DPO | 24 horas |

### 5.2 Cenário: Perda de Dados por Erro Humano

| Etapa | Ação | Responsável | Tempo Estimado |
|-------|------|-------------|----------------|
| 1 | Identificar timestamp exato do evento | CTO | 15 minutos |
| 2 | Restaurar via PITR para momento anterior | CTO | 60-90 minutos |
| 3 | Comparar dados restaurados vs. produção | CTO | 30 minutos |
| 4 | Aplicar merge seletivo se necessário | CTO | 60 minutos |
| 5 | Notificar DPO se dados pessoais afetados | CTO | Imediato |

### 5.3 Cenário: Indisponibilidade Total da API

| Etapa | Ação | Responsável | Tempo Estimado |
|-------|------|-------------|----------------|
| 1 | Alerta automático (`renoveja-ecs-zero-tasks`) | Sistema | Imediato |
| 2 | ECS circuit breaker tenta rollback automático | ECS | 5-10 minutos |
| 3 | Se rollback falhou: deploy manual da última imagem estável | CTO | 15 minutos |
| 4 | Verificar saúde de todos os componentes | CTO | 15 minutos |
| 5 | Comunicar município(s) afetado(s) | CTO | 30 minutos |

### 5.4 Cenário: Comprometimento de Segurança

| Etapa | Ação | Responsável | Tempo Estimado |
|-------|------|-------------|----------------|
| 1 | Isolar sistema comprometido | CTO | Imediato |
| 2 | Ativar Plano de Resposta a Incidentes LGPD | DPO + CTO | 1 hora |
| 3 | Restaurar de backup limpo (pré-comprometimento) | CTO | 2-4 horas |
| 4 | Rotacionar todas as credenciais | CTO | 2 horas |
| 5 | Notificar ANPD (se dados pessoais expostos) | DPO | Até 48 horas |

---

## 6. Testes de Recuperação

### 6.1 Cronograma

| Tipo de Teste | Frequência | Descrição |
|---------------|------------|-----------|
| **Restauração de Snapshot** | Mensal | Restaurar último snapshot em instância temporária; validar integridade |
| **PITR (Point-in-Time Recovery)** | Trimestral | Restaurar para timestamp específico; comparar contagem de registros |
| **Recovery de ECS** | Trimestral | Simular task failure; verificar auto-recovery e health checks |
| **DR Completo** | Semestral | Simular perda completa; reconstruir infra do zero via Terraform + backup |
| **Rebuild Multi-Região** | Anual | Testar reconstrução em região alternativa |

> ⚠️ **Nenhum destes testes foi executado até 01/08/2026.** O cronograma acima é
> o compromisso, não o histórico. Não há registro de execução em lugar nenhum do
> repositório — e, pela seção 6.2, se houvesse execução haveria registro.
>
> Consequência direta e honesta: o **RTO de 4 horas da seção 3 nunca foi
> cronometrado**. É uma estimativa derivada dos tempos de restauração típicos do
> RDS, não uma medição. Ao apresentar esta política a um município, apresente o
> RTO como alvo.

### 6.2 Registro de Testes

Cada teste deve ser documentado com:
- Data e hora
- Tipo de teste executado
- Tempo de recuperação medido
- Integridade dos dados (contagem de registros, checksums)
- Problemas encontrados e ações corretivas
- Responsável pela execução

---

## 7. Retenção de Dados

| Tipo de Dado | Retenção | Base Legal |
|--------------|----------|------------|
| Dados clínicos (receitas, prontuários) | 20 anos | CFM — Resolução 1.821/2007 |
| Logs de auditoria | 5 anos | LGPD — legítimo interesse + obrigação legal |
| Dados pessoais de pacientes | Enquanto houver relação; após: anonimizar ou excluir | LGPD — Art. 16 |
| Backups de banco de dados | **14 dias na AWS hoje; 30 é o prometido** — ver §4.1, retenção | Operacional |
| Logs de aplicação (CloudWatch, `/ecs/renoveja-api`) | **30 dias** — `infra/ecs.tf`, `retention_in_days = 30`. Corrigido em 22/08/2026: esta linha dizia 90 dias, que não é o que a infra aplica (e fica abaixo dos 6 meses do art. 15 do Marco Civil) | Operacional |
| Versões de documentos (S3) | 20 anos | CFM |

---

## 8. Responsabilidades

| Papel | Responsabilidade |
|-------|-----------------|
| **CTO** | Executar e validar testes de recuperação; manter procedimentos atualizados |
| **DPO** | Avaliar impacto à privacidade em cenários de perda de dados |
| **Equipe Técnica** | Monitorar alertas; executar procedimentos sob supervisão |

---

## 9. Infraestrutura de Suporte

| Componente | Configuração | Estado real |
|------------|-------------|-------------|
| **ECS Circuit Breaker** | Rollback automático em falha de health check | ✅ Aplicado — `deployment_circuit_breaker { enable = true, rollback = true }` |
| **Auto-Scaling** | 2-10 tasks; target CPU 70% | ✅ Aplicado — `infra/ecs.tf` |
| **Multi-AZ** | RDS (sa-east-1a + sa-east-1b); ECS distribuído | ❌ **Prometido e não entregue** — `MultiAZ: false` na AWS em 19/09/2026, AZ única `sa-east-1b`. O `database.tf` declara `true` porque é compromisso contratual com o Campo Novo; a declaração nunca virou apply. Cumprir custa US$ 201/mês on-demand ou US$ 124/mês com reserva. Decisão de orçamento pendente. (O ECS **está** distribuído: o serviço roda nas subnets privadas das duas AZs) |
| **CloudWatch Alarms** | P0: sem alvo saudável no ALB, 5xx > 5%, storage < 2GB. P1: CPU > 80%, connections > 60, storage < 4GB | ✅ **Aplicados desde 19/09/2026** — 24 alarmes em sa-east-1 e 5 em us-east-1, todos com destino SNS e assinatura confirmada, mais painel `renoveja-producao` e 2 checagens externas do Route 53. Criados por CLI; `infra/cloudwatch-alarms.tf` descreve o conjunto vivo com blocos `import` |

---

## 10. Melhorias Planejadas

| Melhoria | Prioridade | Prazo Estimado |
|----------|-----------|----------------|
| Replicação cross-region (sa-east-1 → us-east-1) | Média | Q4 2026 |
| Automação de testes de restauração (script mensal) | Alta | Q3 2026 |
| Backup de segredos SSM para vault secundário | Média | Q3 2026 |
| Runbook automatizado para PITR | Alta | Q2 2026 |

---

**Próxima revisão:** Outubro de 2026

---

*RenoveJá Saúde Digital LTDA*  
*Este documento é confidencial e destinado exclusivamente a fins de conformidade.*
