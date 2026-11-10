import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceToGeometry, pickTapFeature, TAP_RADIUS } from '../src/map-tap.js';

// Screen pixels equal map units here, so geometry is written directly in pixels.
const project = ([x, y]) => ({ x, y });
const square = (x, y, size) => [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]];
const country = (id, geometry) => ({ properties: { id, name: id }, geometry });
const big = country('BIG', { type: 'Polygon', coordinates: [square(0, 0, 100), square(40, 40, 20)] });
const enclave = country('LSO', { type: 'Polygon', coordinates: [square(40, 40, 20)] });
const islands = country('ISL', { type: 'MultiPolygon', coordinates: [[square(200, 0, 4)], [square(220, 0, 4)]] });

test('a tap inside a country picks it, even near a border', () => {
  assert.equal(pickTapFeature([big, enclave], { x: 10, y: 10 }, project).properties.id, 'BIG');
  assert.equal(pickTapFeature([islands, big], { x: 98, y: 50 }, project).properties.id, 'BIG');
});

test('a hole belongs to the enclave, not the country around it', () => {
  assert.equal(distanceToGeometry({ x: 50, y: 50 }, big.geometry, project), 10);
  assert.equal(pickTapFeature([big, enclave], { x: 50, y: 50 }, project).properties.id, 'LSO');
});

test('a near miss picks the closest country within the tap radius', () => {
  assert.equal(distanceToGeometry({ x: 210, y: 2 }, islands.geometry, project), 6);
  assert.equal(pickTapFeature([big, islands], { x: 210, y: 2 }, project).properties.id, 'ISL');
  assert.equal(pickTapFeature([big, islands], { x: 106, y: 50 }, project).properties.id, 'BIG');
  assert.equal(pickTapFeature([big, islands], { x: 150, y: 50 }, project), null);
});

test('ocean taps farther than the radius from every coast pick nothing', () => {
  assert.equal(pickTapFeature([big], { x: 100 + TAP_RADIUS + 1, y: 50 }, project), null);
  assert.equal(pickTapFeature([big], { x: 100 + TAP_RADIUS, y: 50 }, project).properties.id, 'BIG');
  assert.equal(pickTapFeature([], { x: 0, y: 0 }, project), null);
});

test('every tile copy of a country is measured and other geometry types are ignored', () => {
  const clipped = country('BIG', { type: 'Polygon', coordinates: [square(0, 0, 30)] });
  const point = country('PT', { type: 'Point', coordinates: [5, 5] });
  assert.equal(pickTapFeature([point, clipped, big], { x: 60, y: 10 }, project), big);
  assert.equal(distanceToGeometry({ x: 5, y: 5 }, point.geometry, project), Infinity);
});
