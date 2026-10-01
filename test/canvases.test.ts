import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canvasFilenameFromRef,
  canvasFilenamesFromChat,
  cursorProjectSlug,
  isCanvasFilename,
} from '../src/canvases';

/** Canvas basename from the RocksDB chat. */
const NAME = 'dos-conan-migration-map.canvas.tsx';

test('cursorProjectSlug matches Cursor project directory names', () => {
  assert.equal(
    cursorProjectSlug(
      '/home/oshokin/go/src/gitlab.stageoffice.ru/UCS-PLATFORM/dispersed-object-store',
    ),
    'home-oshokin-go-src-gitlab-stageoffice-ru-UCS-PLATFORM-dispersed-object-store',
  );

  assert.equal(
    cursorProjectSlug(
      '/home/oshokin/go/src/gitlab.stageoffice.ru/nct-devops/ansible_collections/nct.dispersed_object_store',
    ),
    'home-oshokin-go-src-gitlab-stageoffice-ru-nct-devops-ansible-collections-nct-dispersed-object-store',
  );
});

test('canvas names must sit in a canvases directory', () => {
  assert.equal(isCanvasFilename(NAME), true);
  assert.equal(isCanvasFilename(`../${NAME}`), false);
  assert.equal(canvasFilenameFromRef(`/tmp/not-canvases/${NAME}`), null);

  assert.equal(
    canvasFilenameFromRef(
      `/home/oshokin/.cursor/projects/example/canvases/${NAME}`,
    ),
    NAME,
  );
});

test('canvasFilenamesFromChat reads URI objects and skips text', () => {
  const names = canvasFilenamesFromChat(
    JSON.stringify({
      uri: {
        scheme: 'file',
        path: `/evil/canvases/${NAME}`,
        external: `file:///evil/canvases/${NAME}`,
      },
      text: `see /evil/canvases/${NAME}`,
    }),
    [
      {
        key: 'bubbleId:a:b',
        bubbleId: 'b',
        value: JSON.stringify({
          rawText: `/evil/canvases/${NAME}`,
          relativeWorkspacePath: `/also/canvases/${NAME}`,
        }),
      },
    ],
  );

  assert.deepEqual(names, [NAME]);
});
