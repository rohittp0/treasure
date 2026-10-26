import { readFileSync, writeFileSync } from 'node:fs';

const path = new URL('../public/countries.geojson', import.meta.url);
const source = JSON.parse(readFileSync(path, 'utf8'));
const compact = {
  type: 'FeatureCollection',
  features: source.features.map(({ geometry, properties }) => ({
    type: 'Feature',
    id: properties.ADM0_A3 || properties.id,
    properties: {
      id: properties.ADM0_A3 || properties.id,
      name: properties.NAME_EN || properties.ADMIN || properties.name,
      labelX: properties.LABEL_X ?? properties.labelX,
      labelY: properties.LABEL_Y ?? properties.labelY,
    },
    geometry,
  })),
};
writeFileSync(path, JSON.stringify(compact));
console.log(`Prepared ${compact.features.length} country outlines`);
