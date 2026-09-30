// Sample images for the styleguide, drawn as SVG data URIs (the CSP allows data: images and the
// styleguide must not depend on storage). Not used by product pages.

function svg(markup: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
}

const LABEL = "font-family='system-ui, -apple-system, Segoe UI, sans-serif' font-weight='600'";
const INK = "fill='#4a463e'";

export const MAP_WIDTH = 1200;
export const MAP_HEIGHT = 800;

export const CAMPUS_MAP = svg(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 800' width='1200' height='800'>
  <rect width='1200' height='800' fill='#edf0e4'/>
  <path d='M0 395H1200M395 0V800M820 0V800' stroke='#f9f7f0' stroke-width='30'/>
  <rect x='60' y='470' width='300' height='270' rx='18' fill='#b8d6a6' stroke='#fff' stroke-width='4'/>
  <path d='M210 470V740M60 605H360' stroke='#fff' stroke-width='3'/>
  <circle cx='210' cy='605' r='38' fill='none' stroke='#fff' stroke-width='3'/>
  <rect x='70' y='80' width='290' height='270' rx='10' fill='#d9d3c5' stroke='#a79f8f' stroke-width='3'/>
  <rect x='440' y='80' width='340' height='180' rx='10' fill='#d9d3c5' stroke='#a79f8f' stroke-width='3'/>
  <rect x='860' y='100' width='280' height='200' rx='10' fill='#d9d3c5' stroke='#a79f8f' stroke-width='3'/>
  <rect x='470' y='320' width='300' height='150' rx='10' fill='#d9d3c5' stroke='#a79f8f' stroke-width='3'/>
  <rect x='860' y='380' width='280' height='340' rx='10' fill='#d9d3c5' stroke='#a79f8f' stroke-width='3'/>
  <rect x='450' y='540' width='330' height='200' rx='10' fill='#cfcfcb' stroke='#b1b1ab' stroke-width='3'/>
  <path d='M490 560V720M545 560V720M600 560V720M655 560V720M710 560V720' stroke='#f4f4f0' stroke-width='3'/>
  <text x='215' y='222' ${LABEL} ${INK} font-size='30' text-anchor='middle'>Gym</text>
  <text x='610' y='178' ${LABEL} ${INK} font-size='30' text-anchor='middle'>Main Office</text>
  <text x='1000' y='208' ${LABEL} ${INK} font-size='30' text-anchor='middle'>Library</text>
  <text x='620' y='403' ${LABEL} ${INK} font-size='30' text-anchor='middle'>Cafeteria</text>
  <text x='1000' y='558' ${LABEL} ${INK} font-size='30' text-anchor='middle'>West Wing</text>
  <text x='210' y='580' ${LABEL} font-size='26' text-anchor='middle' fill='#3f5a35'>Field</text>
  <text x='615' y='650' ${LABEL} font-size='26' text-anchor='middle' fill='#6b6b66'>Parking</text>
</svg>`);

export const DEMO_ZONES = [
  { id: 'z-gym', name: 'Gym', cx: 0.179, cy: 0.269, radius: 0.13 },
  { id: 'z-office', name: 'Main Office', cx: 0.508, cy: 0.213, radius: 0.1 },
  { id: 'z-library', name: 'Library', cx: 0.833, cy: 0.25, radius: 0.1 },
  { id: 'z-cafe', name: 'Cafeteria', cx: 0.517, cy: 0.494, radius: 0.1 },
  { id: 'z-west', name: 'West Wing', cx: 0.833, cy: 0.688, radius: 0.13 },
  { id: 'z-field', name: 'Field', cx: 0.175, cy: 0.756, radius: 0.14 },
];

export const DEMO_MARKERS = [
  { id: 'loc-main', x: 0.508, y: 0.335, label: 'Main Office' },
  { id: 'loc-west', x: 0.72, y: 0.62, label: 'West desk' },
];

function photo(bg: string, body: string): string {
  return svg(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 400' width='400' height='400'>
  <defs><linearGradient id='g' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='${bg}'/><stop offset='1' stop-color='#b9b2a3'/></linearGradient></defs>
  <rect width='400' height='400' fill='url(#g)'/>
  <ellipse cx='200' cy='352' rx='120' ry='16' fill='#000' opacity='.12'/>
  ${body}
</svg>`);
}

export const PHOTO_BOTTLE = photo(
  '#dfe8ec',
  `<rect x='165' y='60' width='70' height='40' rx='10' fill='#2b2f36'/>
   <path d='M168 100h64v28c0 10 22 18 22 44v162c0 12-10 20-22 20h-64c-12 0-22-8-22-20V172c0-26 22-34 22-44z' fill='#1e3a5f'/>
   <rect x='160' y='200' width='80' height='60' rx='8' fill='#f2a93b'/>
   <circle cx='220' cy='300' r='14' fill='#e25f5f'/>`,
);

export const PHOTO_BACKPACK = photo(
  '#efe4d6',
  `<path d='M150 110a50 50 0 0 1 100 0' fill='none' stroke='#7a1d1d' stroke-width='16'/>
   <rect x='110' y='110' width='180' height='230' rx='40' fill='#c0392b'/>
   <rect x='140' y='230' width='120' height='90' rx='18' fill='#a93226'/>
   <path d='M150 250h100' stroke='#f5d76e' stroke-width='6'/>`,
);

export const PHOTO_HOODIE = photo(
  '#e3ecdf',
  `<path d='M150 80l-80 50 30 70 30-14V340h140V186l30 14 30-70-80-50c-10 30-30 44-50 44s-40-14-50-44z' fill='#2e7d5b'/>
   <path d='M170 190h60v50h-60z' fill='#256b4d'/>
   <circle cx='188' cy='120' r='5' fill='#fff'/><circle cx='212' cy='120' r='5' fill='#fff'/>`,
);

export const PHOTO_BOTTLE_2 = photo(
  '#e9e2f0',
  `<rect x='170' y='70' width='60' height='36' rx='8' fill='#555'/>
   <path d='M172 106h56v26c0 8 18 16 18 38v168c0 10-8 18-18 18h-56c-10 0-18-8-18-18V170c0-22 18-30 18-38z' fill='#8e44ad'/>`,
);
