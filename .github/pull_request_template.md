## Resumo

Descreva o problema, a hipótese/objetivo técnico e o que mudou.

## Evidência de engenharia

- [ ] Build/testes relevantes executados (se NÃO executados, declarar aqui como "não validado" — nunca como "passou")
- [ ] Nenhum teste/gate foi removido, desabilitado ou marcado `continue-on-error` para obter status verde
- [ ] Migrations são idempotentes quando aplicável
- [ ] Alterações de persistência/auditoria preservam append-only quando exigido
- [ ] Não foram adicionados PHI/PII, segredos ou credenciais ao repositório/logs
- [ ] Documentação foi atualizada quando o comportamento mudou
- [ ] Nenhum texto/UI passou a declarar "assinatura válida", homologação ou certificação sem evidência correspondente
- [ ] Mudança clínica (prescrição, dose, alerta, fluxo assistencial) recebeu revisão de profissional habilitado

## IA clínica (StarMed)

Preencher quando o PR tocar `Intelligence`, evidências, Gates, shadow, modelos, risco ou superfícies clínicas:

- [ ] `EffectiveAt` / `RecordedAt` e proteção contra temporal leakage foram preservados
- [ ] Missing não foi convertido silenciosamente em zero/false
- [ ] Unidade/terminologia não foi inferida sem governança
- [ ] Modelo, protocolo, dataset/features e fingerprints continuam reconstruíveis
- [ ] Threshold/critério clínico não foi inventado no código
- [ ] Shadow mode continua sem efeito assistencial
- [ ] Human-in-the-loop continua aplicado quando a policy exige
- [ ] Promoção de lifecycle depende de evidência/papéis aprovadores
- [ ] Nenhum texto/API/UI passou a declarar STRL, validade clínica ou certificação automaticamente
- [ ] Evidências externas inexistentes não foram simuladas ou fabricadas

## Segurança e rollback

- [ ] Impacto em autorização/tenant foi revisado
- [ ] Impacto em logs/auditoria foi revisado
- [ ] Plano de rollback é conhecido para mudança operacional relevante
- [ ] Mudança de workflow/dependência/infra foi tratada como supply-chain crítica

## Como verificar

Inclua comandos, rotas, screenshots não sensíveis, digests ou referências de CI suficientes para um revisor reproduzir a verificação.
