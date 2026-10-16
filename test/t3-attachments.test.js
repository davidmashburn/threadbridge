const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { prepareAttachments } = require("../src/adapters/t3/attachments");

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "threadbridge-t3-attachments-test-"));
  const sourceRoot = path.join(root, "source");
  const targetRoot = path.join(root, "target");
  const sourceDbPath = path.join(sourceRoot, "statev2.sqlite");
  const targetDbPath = path.join(targetRoot, "statev2.sqlite");
  fs.mkdirSync(path.join(sourceRoot, "attachments"), { recursive: true });
  fs.mkdirSync(targetRoot, { recursive: true });
  fs.writeFileSync(sourceDbPath, "source");
  fs.writeFileSync(targetDbPath, "target");
  return { root, sourceRoot, targetRoot, sourceDbPath, targetDbPath };
}

function makeIr(sourceDbPath, attachments, overrides = {}) {
  const sourceRoot = path.dirname(sourceDbPath);
  return {
    source: { harness: "t3", sourcePath: sourceDbPath },
    thread: { workspaceRoot: sourceRoot },
    project: { workspaceRoot: sourceRoot },
    messages: [
      {
        id: "message-1",
        role: "user",
        content: "fixture",
        attachments,
      },
    ],
    ...overrides,
  };
}

function removeFixture(fixture) {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

test("transfers stock image attachments and emits canonical metadata", () => {
  const fixture = createFixture();
  try {
    const bytes = Buffer.from("fixture image bytes");
    fs.writeFileSync(
      path.join(fixture.sourceRoot, "attachments", "fixture-image.png"),
      bytes,
    );
    const input = {
      type: "image",
      id: "fixture-image",
      name: "fixture.png",
      mimeType: "image/png",
      sizeBytes: 999,
    };
    const prepared = prepareAttachments({
      ir: makeIr(fixture.sourceDbPath, [input]),
      targetDbPath: fixture.targetDbPath,
    });

    assert.equal(prepared.count, 1);
    assert.deepEqual(prepared.warnings, []);
    const canonical = prepared.messages[0].attachments[0];
    assert.deepEqual(Object.keys(canonical).sort(), [
      "id",
      "mimeType",
      "name",
      "sizeBytes",
      "type",
    ]);
    assert.equal(canonical.type, "image");
    assert.equal(canonical.name, "fixture.png");
    assert.equal(canonical.mimeType, "image/png");
    assert.equal(canonical.sizeBytes, bytes.length);
    assert.match(canonical.id, /^[a-z0-9_-]{1,128}$/i);
    assert.notEqual(canonical.id, input.id);

    const published = prepared.publish();
    const targetPath = path.join(fixture.targetRoot, "attachments", `${canonical.id}.png`);
    assert.deepEqual(published.files, [targetPath]);
    assert.deepEqual(fs.readFileSync(targetPath), bytes);
    prepared.cleanup();
  } finally {
    removeFixture(fixture);
  }
});

test("resolves stock file IDs and preserves their safe extensions", () => {
  const fixture = createFixture();
  try {
    const bytes = Buffer.from("fixture pdf bytes");
    const sourceId = "thread-1-00000000-0000-4000-8000-000000000002-pdf";
    fs.writeFileSync(
      path.join(fixture.sourceRoot, "attachments", `${sourceId}.pdf`),
      bytes,
    );
    const prepared = prepareAttachments({
      ir: makeIr(fixture.sourceDbPath, [{
        type: "file",
        id: sourceId,
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: bytes.length,
      }]),
      targetDbPath: fixture.targetDbPath,
    });

    assert.equal(prepared.count, 1);
    assert.deepEqual(prepared.warnings, []);
    const canonical = prepared.messages[0].attachments[0];
    assert.equal(canonical.type, "file");
    assert.equal(canonical.name, "report.pdf");
    assert.equal(canonical.mimeType, "application/pdf");
    assert.equal(canonical.sizeBytes, bytes.length);
    prepared.publish();
    assert.deepEqual(
      fs.readFileSync(path.join(fixture.targetRoot, "attachments", `${canonical.id}.pdf`)),
      bytes,
    );
    prepared.cleanup();
  } finally {
    removeFixture(fixture);
  }
});

test("canonicalizes inline bytes without leaking bytes or path fields", () => {
  const fixture = createFixture();
  try {
    const bytes = Buffer.from("inline image bytes");
    const input = {
      type: "image",
      id: "inline-image",
      name: "inline.png",
      mimeType: "image/png",
      sizeBytes: 1,
      bytes,
      path: "/outside/source.png",
      filePath: "/outside/file.png",
      localPath: "/outside/local.png",
      data: Buffer.from("duplicate payload field"),
    };
    const original = { ...input };
    const prepared = prepareAttachments({
      ir: makeIr(fixture.sourceDbPath, [input]),
      targetDbPath: fixture.targetDbPath,
    });

    const canonical = prepared.messages[0].attachments[0];
    assert.equal(prepared.count, 1);
    assert.equal(canonical.name, "inline.png");
    assert.equal(canonical.mimeType, "image/png");
    assert.equal(canonical.sizeBytes, bytes.length);
    assert.equal(Object.hasOwn(canonical, "bytes"), false);
    assert.equal(Object.hasOwn(canonical, "data"), false);
    assert.equal(Object.hasOwn(canonical, "path"), false);
    assert.equal(Object.hasOwn(canonical, "filePath"), false);
    assert.deepEqual(input, original);
    prepared.cleanup();
  } finally {
    removeFixture(fixture);
  }
});

test("uses the stock MIME-first image extension resolver", () => {
  const fixture = createFixture();
  try {
    const bytes = Buffer.from("png despite the name");
    fs.writeFileSync(
      path.join(fixture.sourceRoot, "attachments", "mime-first.png"),
      bytes,
    );
    const prepared = prepareAttachments({
      ir: makeIr(fixture.sourceDbPath, [{
        type: "image",
        id: "mime-first",
        name: "picture.jpg",
        mimeType: "image/png",
      }]),
      targetDbPath: fixture.targetDbPath,
    });

    const canonical = prepared.messages[0].attachments[0];
    assert.equal(prepared.count, 1);
    assert.equal(canonical.name, "picture.jpg");
    assert.equal(canonical.mimeType, "image/png");
    prepared.publish();
    assert.equal(fs.existsSync(path.join(fixture.targetRoot, "attachments", `${canonical.id}.png`)), true);
    assert.equal(fs.existsSync(path.join(fixture.targetRoot, "attachments", `${canonical.id}.jpg`)), false);
    prepared.cleanup();
  } finally {
    removeFixture(fixture);
  }
});

test("assigns IDs during preparation and makes publish retry-safe", () => {
  const fixture = createFixture();
  try {
    const prepared = prepareAttachments({
      ir: makeIr(fixture.sourceDbPath, [{
        type: "file",
        name: "notes.txt",
        mimeType: "text/plain",
        bytes: Buffer.from("retry me"),
      }]),
      targetDbPath: fixture.targetDbPath,
    });
    const eventAttachments = JSON.parse(JSON.stringify(prepared.messages[0].attachments));
    const first = prepared.publish();
    const second = prepared.publish();

    assert.deepEqual(second, first);
    prepared.rollback();
    assert.equal(fs.existsSync(first.files[0]), false);
    assert.deepEqual(prepared.publish(), first);
    assert.deepEqual(prepared.messages[0].attachments, eventAttachments);
    assert.equal(first.files.length, 1);
    assert.equal(fs.existsSync(first.files[0]), true);
    prepared.cleanup();
    assert.equal(fs.existsSync(first.files[0]), true);
  } finally {
    removeFixture(fixture);
  }
});

test("throws on a destination collision without overwriting or changing IDs", () => {
  const fixture = createFixture();
  try {
    const prepared = prepareAttachments({
      ir: makeIr(fixture.sourceDbPath, [{
        type: "image",
        name: "collision.png",
        mimeType: "image/png",
        bytes: Buffer.from("new bytes"),
      }]),
      targetDbPath: fixture.targetDbPath,
    });
    const canonical = prepared.messages[0].attachments[0];
    const targetDir = path.join(fixture.targetRoot, "attachments");
    const targetPath = path.join(targetDir, `${canonical.id}.png`);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(targetPath, "existing bytes");

    assert.throws(() => prepared.publish(), (error) => error.code === "EEXIST");
    assert.equal(fs.readFileSync(targetPath, "utf8"), "existing bytes");
    assert.equal(prepared.messages[0].attachments[0].id, canonical.id);

    fs.unlinkSync(targetPath);
    assert.deepEqual(prepared.publish().files, [targetPath]);
    prepared.rollback();
    prepared.cleanup();
    assert.equal(fs.existsSync(targetPath), false);
  } finally {
    removeFixture(fixture);
  }
});

test("rollback removes only files published by its preparation", () => {
  const fixture = createFixture();
  try {
    const targetDir = path.join(fixture.targetRoot, "attachments");
    fs.mkdirSync(targetDir, { recursive: true });
    const keepPath = path.join(targetDir, "keep.txt");
    fs.writeFileSync(keepPath, "keep me");
    const prepared = prepareAttachments({
      ir: makeIr(fixture.sourceDbPath, [{
        type: "file",
        name: "owned.txt",
        mimeType: "text/plain",
        bytes: Buffer.from("owned"),
      }]),
      targetDbPath: fixture.targetDbPath,
    });
    const targetPath = path.join(targetDir, `${prepared.messages[0].attachments[0].id}.txt`);

    prepared.publish();
    prepared.rollback();
    prepared.cleanup();
    assert.equal(fs.existsSync(targetPath), false);
    assert.equal(fs.readFileSync(keepPath, "utf8"), "keep me");
  } finally {
    removeFixture(fixture);
  }
});

test("partial publish rollback removes only this preparation's files", () => {
  const fixture = createFixture();
  try {
    const prepared = prepareAttachments({
      ir: makeIr(fixture.sourceDbPath, [
        {
          type: "file",
          name: "first.txt",
          mimeType: "text/plain",
          bytes: Buffer.from("first"),
        },
        {
          type: "file",
          name: "second.txt",
          mimeType: "text/plain",
          bytes: Buffer.from("second"),
        },
      ]),
      targetDbPath: fixture.targetDbPath,
    });
    const targetDir = path.join(fixture.targetRoot, "attachments");
    const [first, second] = prepared.messages[0].attachments;
    const firstPath = path.join(targetDir, `${first.id}.txt`);
    const secondPath = path.join(targetDir, `${second.id}.txt`);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(secondPath, "unrelated collision");

    assert.throws(() => prepared.publish(), (error) => error.code === "EEXIST");
    assert.equal(fs.existsSync(firstPath), true);
    prepared.rollback();
    prepared.cleanup();
    assert.equal(fs.existsSync(firstPath), false);
    assert.equal(fs.readFileSync(secondPath, "utf8"), "unrelated collision");
  } finally {
    removeFixture(fixture);
  }
});

test("warns and drops attachments with missing bytes", () => {
  const fixture = createFixture();
  try {
    const prepared = prepareAttachments({
      ir: makeIr(fixture.sourceDbPath, [{
        type: "image",
        id: "missing-image",
        name: "missing.png",
        mimeType: "image/png",
      }]),
      targetDbPath: fixture.targetDbPath,
    });

    assert.equal(prepared.count, 0);
    assert.equal(prepared.messages[0].attachments.length, 0);
    assert.equal(prepared.warnings.length, 1);
    assert.equal(prepared.warnings[0].code, "attachment_missing");
    prepared.cleanup();
  } finally {
    removeFixture(fixture);
  }
});

test("does not follow a source attachments-directory symlink", () => {
  const fixture = createFixture();
  try {
    const outside = path.join(fixture.root, "source-outside");
    const sourceAttachments = path.join(fixture.sourceRoot, "attachments");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "fixture-image.png"), "outside bytes");
    fs.rmSync(sourceAttachments, { recursive: true, force: true });
    fs.symlinkSync(outside, sourceAttachments, "dir");

    const prepared = prepareAttachments({
      ir: makeIr(fixture.sourceDbPath, [{
        type: "image",
        id: "fixture-image",
        name: "fixture.png",
        mimeType: "image/png",
      }]),
      targetDbPath: fixture.targetDbPath,
    });

    assert.equal(prepared.count, 0);
    assert.equal(prepared.warnings[0].code, "attachment_missing");
    assert.equal(fs.readFileSync(path.join(outside, "fixture-image.png"), "utf8"), "outside bytes");
    prepared.cleanup();
  } finally {
    removeFixture(fixture);
  }
});

test("does not follow a source attachment-file symlink outside the source root", () => {
  const fixture = createFixture();
  try {
    const outside = path.join(fixture.root, "outside.png");
    const sourceLink = path.join(fixture.sourceRoot, "source-link.png");
    fs.writeFileSync(outside, "outside bytes");
    fs.symlinkSync(outside, sourceLink);

    const prepared = prepareAttachments({
      ir: makeIr(fixture.sourceDbPath, [{
        type: "image",
        id: "source-link",
        name: "source-link.png",
        mimeType: "image/png",
        path: sourceLink,
      }]),
      targetDbPath: fixture.targetDbPath,
    });

    assert.equal(prepared.count, 0);
    assert.equal(prepared.warnings[0].code, "attachment_missing");
    assert.equal(fs.readFileSync(outside, "utf8"), "outside bytes");
    prepared.cleanup();
  } finally {
    removeFixture(fixture);
  }
});

test("rejects a destination attachments-directory symlink", () => {
  const fixture = createFixture();
  try {
    const outside = path.join(fixture.root, "target-outside");
    const targetAttachments = path.join(fixture.targetRoot, "attachments");
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, targetAttachments, "dir");
    const prepared = prepareAttachments({
      ir: makeIr(fixture.sourceDbPath, [{
        type: "image",
        name: "image.png",
        mimeType: "image/png",
        bytes: Buffer.from("must stay inside"),
      }]),
      targetDbPath: fixture.targetDbPath,
    });

    assert.throws(() => prepared.publish(), /must not be a symlink/);
    assert.deepEqual(fs.readdirSync(outside), []);
    prepared.rollback();
    prepared.cleanup();
  } finally {
    removeFixture(fixture);
  }
});

test("rollback in the source database leaves the source asset intact", () => {
  const fixture = createFixture();
  try {
    const bytes = Buffer.from("source asset");
    const sourcePath = path.join(fixture.sourceRoot, "attachments", "fixture-image.png");
    fs.writeFileSync(sourcePath, bytes);
    const prepared = prepareAttachments({
      ir: makeIr(fixture.sourceDbPath, [{
        type: "image",
        id: "fixture-image",
        name: "fixture.png",
        mimeType: "image/png",
      }]),
      targetDbPath: fixture.sourceDbPath,
    });

    const targetPath = path.join(
      fixture.sourceRoot,
      "attachments",
      `${prepared.messages[0].attachments[0].id}.png`,
    );
    prepared.publish();
    prepared.rollback();
    prepared.cleanup();
    assert.equal(fs.existsSync(targetPath), false);
    assert.deepEqual(fs.readFileSync(sourcePath), bytes);
  } finally {
    removeFixture(fixture);
  }
});
