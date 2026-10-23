/**
 * CPF/CNS no cliente: máscara de digitação e aviso imediato de DV inválido.
 * Mesmas regras de apps/api/src/br-identifiers.ts — o servidor (e o CHECK da
 * migração 028) continuam sendo a autoridade; aqui é só ergonomia.
 */
const digits = (v: string) => v.replace(/\D/g, '');

export function isValidCpf(v: string): boolean {
  const d = digits(v);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const dv = (len: number) => {
    let s = 0;
    for (let i = 0; i < len; i++) s += Number(d[i]) * (len + 1 - i);
    const r = s % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}

export function isValidCns(v: string): boolean {
  const d = digits(v);
  if (d.length !== 15 || !'12789'.includes(d[0])) return false;
  let s = 0;
  for (let i = 0; i < 15; i++) s += Number(d[i]) * (15 - i);
  return s % 11 === 0;
}

export function formatCpf(v: string): string {
  const d = digits(v).slice(0, 11);
  return d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
}

export function formatCns(v: string): string {
  const d = digits(v).slice(0, 15);
  return [d.slice(0, 3), d.slice(3, 7), d.slice(7, 11), d.slice(11)].filter(Boolean).join(' ');
}

/** '' = vazio (opcional); 'ok' = completo e válido; 'invalid' = completo com DV errado ou incompleto. */
export function docState(v: string, kind: 'cpf' | 'cns'): '' | 'ok' | 'invalid' {
  if (!digits(v)) return '';
  return (kind === 'cpf' ? isValidCpf(v) : isValidCns(v)) ? 'ok' : 'invalid';
}
