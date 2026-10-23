# Evidência de produto — do "melhor do mundo" a alegações comprováveis

Quatro frentes separam o StarMed de qualquer alegação competitiva. Cada documento abaixo é executável: diz quem faz, com o quê, em que ordem, com que critério de sucesso e que evidência fica.

| # | Frente | Documento | Quem executa | Depende de |
|---|---|---|---|---|
| 1 | Uso real controlado | [PROTOCOLO_PILOTO.md](PROTOCOLO_PILOTO.md) | Clínica-piloto + direção clínica + engenharia | Frentes 2 e 3 concluídas para o escopo do piloto |
| 2 | Homologações externas | [PLANO_HOMOLOGACOES.md](PLANO_HOMOLOGACOES.md) | Engenharia + jurídico + fornecedores | Contratos, certificados e credenciais externas |
| 3 | Revisão clínica e regulatória | [PACOTE_REVISAO_CLINICA_REGULATORIA.md](PACOTE_REVISAO_CLINICA_REGULATORIA.md) | Médico responsável, farmacêutico, jurídico/regulatório | Nomeação formal dos revisores |
| 4 | Comparação com o mercado | [PROTOCOLO_ESTUDO_COMPARATIVO.md](PROTOCOLO_ESTUDO_COMPARATIVO.md) + kit em `scripts/estudo/` | Pesquisador independente + médicos voluntários | Acesso autorizado aos sistemas comparados |

## Ordem recomendada

```
3. revisão clínica/regulatória ──┐
                                 ├──► 1. piloto (escopo reduzido) ──► 4. estudo comparativo
2. homologações (as que o escopo │
   do piloto exige)  ────────────┘
```

O estudo comparativo pode começar em paralelo **só com dados sintéticos** (ele não usa paciente real). O piloto não começa sem a frente 3 assinada.

## Regras que valem para as quatro frentes

- **Paciente real só no piloto, e só depois dos gates de produção** do Prompt Mestre (Parte K): CI verde, pentest sem crítico/alto aberto, restore testado, revisão clínica assinada, base legal LGPD definida.
- **Nenhum resultado vira marketing antes do relatório final**, com método, amostra, limitações e quem financiou.
- **Afirmação permitida = afirmação medida.** Exemplo: "em 12 médicos e 6 tarefas padronizadas, a mediana para emitir uma receita foi X s no StarMed contra Y s no sistema Z (p = …)". "Melhor do mundo" não é alegação mensurável.
- Toda evidência fica em `docs/estudo/evidencias/<data>/`, versionada e sem PHI.
