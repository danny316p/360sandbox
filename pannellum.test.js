const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'pannellum.html'), 'utf8');
const viewerConfigMatch = html.match(
  /pannellum\.viewer\(\s*(['"])panorama\1\s*,\s*(\{[\s\S]*?\})\s*\);/
);

assert.ok(viewerConfigMatch, 'viewer configuration should be present');
const config = JSON.parse(viewerConfigMatch[2]);

test('starts in scene1 and uses the configured scene fade duration', () => {
  assert.equal(config.default.firstScene, 'scene1');
  assert.equal(config.default.sceneFadeDuration, 1000);
});

test('defines both equirectangular panoramas', () => {
  assert.deepEqual(Object.keys(config.scenes).sort(), ['scene1', 'scene2']);
  assert.equal(config.scenes.scene1.type, 'equirectangular');
  assert.equal(config.scenes.scene1.panorama, 'photos/location1.jpg');
  assert.equal(config.scenes.scene2.type, 'equirectangular');
  assert.equal(config.scenes.scene2.panorama, 'photos/location2.jpg');
});

test('scene hotspots navigate between the two scenes', () => {
  assert.deepEqual(
    config.scenes.scene1.hotSpots.map(({ type, sceneId }) => ({ type, sceneId })),
    [{ type: 'scene', sceneId: 'scene2' }]
  );
  assert.deepEqual(
    config.scenes.scene2.hotSpots.map(({ type, sceneId }) => ({ type, sceneId })),
    [{ type: 'scene', sceneId: 'scene1' }]
  );
});
