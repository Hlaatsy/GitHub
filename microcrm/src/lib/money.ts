/** Formats ZAR cents the South African way: 125050 -> "R1 250.50". */
export function formatZar(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  const rands = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${sign}R${rands}.${String(abs % 100).padStart(2, '0')}`;
}
