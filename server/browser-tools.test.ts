import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { BrowserPageState } from "./browser-page-state.js";
import { BrowserDriver } from "./browser-tools.js";

const editor = `<!doctype html><html><head><title>Device editor</title><style>
  #modal_overlay { position:fixed; top:30px; right:10000px; bottom:0; left:-10000px; opacity:0; overflow-y:scroll; z-index:900 }
  body.modal-overlay-active #modal_overlay { right:0; left:0; opacity:1 }
  body.modal-overlay-active { overflow:hidden }
  .modal { background:white; margin:20px; padding:20px }
  #mask-options { display:none }
  .cbi-value { margin:12px }
  .transparent { opacity:0 }
</style></head><body>
  <h1>接口列表</h1>
  <button id="edit" onclick="document.body.classList.add('modal-overlay-active')">编辑 FE1</button>
  <button class="save" id="page-save" onclick="statusText.textContent='底层页面已保存'">保存</button>
  <output id="statusText"></output>
  <div class="transparent"><button>透明容器中的按钮</button>透明容器中的内容</div>
  <div aria-hidden="true"><input value="隐藏字段">ARIA 隐藏内容</div>
  <div id="modal_overlay"><div class="modal" role="dialog" aria-modal="true">
    <h4>接口 » FE1</h4>
    <div class="cbi-value"><label class="cbi-value-title">IPv4 地址</label>
      <input id="address" type="text" pattern="[0-9.]+" required>
    </div>
    <div class="cbi-value"><label class="cbi-value-title">IPv4 子网掩码</label>
      <div class="cbi-dropdown" id="mask" role="combobox" aria-expanded="false" tabindex="0"
        onclick="this.setAttribute('aria-expanded','true'); document.getElementById('mask-options').style.display='block'">未指定
        <ul id="mask-options" role="listbox">
          <li role="option" data-value="255.255.255.0" tabindex="0"
            onclick="event.stopPropagation(); this.setAttribute('aria-selected','true')">255.255.255.0</li>
        </ul>
      </div>
    </div>
    <button id="close" onclick="document.body.classList.remove('modal-overlay-active')">关闭</button>
    <button class="save" id="modal-save" onclick="if(address.checkValidity()) { document.body.classList.remove('modal-overlay-active'); statusText.textContent='弹窗已保存'; }">保存</button>
  </div></div>
</body></html>`;

function snapshot(value: string): BrowserPageState {
  return JSON.parse(value) as BrowserPageState;
}

async function withPage(html: string, callback: (driver: BrowserDriver, initial: BrowserPageState) => Promise<void>) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
  });
  const artifacts = await mkdtemp(path.join(tmpdir(), "atp-browser-test-"));
  const driver = new BrowserDriver(artifacts);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const initial = snapshot(await driver.open(`http://127.0.0.1:${address.port}/`));
    await callback(driver, initial);
  } finally {
    await driver.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(artifacts, { recursive: true, force: true });
  }
}

test("closed offscreen LuCI dialogs and hidden ancestor content are excluded from snapshots", async () => {
  await withPage(editor, async (_driver, initial) => {
    assert.equal(initial.activeDialog, undefined);
    assert.equal(initial.elements.filter((element) => element.text === "保存").length, 1);
    assert.ok(!initial.elements.some((element) => element.label === "IPv4 地址" || element.text === "关闭"));
    assert.doesNotMatch(initial.text, /IPv4|透明容器|ARIA 隐藏/);
  });
});

test("modal controls have labels, validation feedback and custom dropdown options; ambiguous selectors scope to the modal", async () => {
  await withPage(editor, async (driver) => {
    let page = snapshot(await driver.click("#edit"));
    assert.equal(page.activeDialog?.title, "接口 » FE1");
    assert.doesNotMatch(page.text, /接口列表/);
    assert.equal(page.elements.filter((element) => element.text === "保存").length, 1);
    const address = page.elements.find((element) => element.label === "IPv4 地址");
    assert.ok(address);

    page = snapshot(await driver.fill(address.ref, "192.168.181.2/24"));
    assert.equal(page.validationErrors[0]?.label, "IPv4 地址");
    assert.ok(page.validationErrors[0]?.message);
    page = snapshot(await driver.click(".save"));
    assert.ok(page.activeDialog);
    assert.ok(page.validationErrors.length);

    page = snapshot(await driver.fill("#address", "192.168.181.2"));
    assert.equal(page.validationErrors.length, 0);
    const dropdown = page.elements.find((element) => element.label === "IPv4 子网掩码" && element.controlType === "custom-select");
    assert.ok(dropdown);
    await assert.rejects(driver.select(dropdown.ref, "255.255.255.0"), /仅支持原生.*自定义控件.*最新页面状态/s);
    page = snapshot(await driver.click("#mask"));
    const option = page.elements.find((element) => element.controlType === "option" && element.text === "255.255.255.0");
    assert.ok(option);
    assert.ok(page.elements.find((element) => element.role === "combobox")?.options?.some((item) => item.value === "255.255.255.0"));
    await driver.click(option.ref);
    page = snapshot(await driver.click(".save"));
    assert.equal(page.activeDialog, undefined);
    assert.match(page.text, /弹窗已保存/);
    assert.doesNotMatch(page.text, /底层页面已保存|IPv4 地址/);
  });
});

test("closed modal targets are rejected with a fresh snapshot and stale refs cannot be reused", async () => {
  await withPage(editor, async (driver) => {
    const opened = snapshot(await driver.click("#edit"));
    const saveRef = opened.elements.find((element) => element.text === "保存")?.ref;
    assert.ok(saveRef);
    const closed = snapshot(await driver.click("#close"));
    assert.equal(closed.activeDialog, undefined);
    await assert.rejects(driver.click("#modal-save"), (error: Error) => {
      assert.match(error.message, /已关闭的弹窗.*最新页面状态/s);
      assert.doesNotMatch(error.message, /outside of the viewport/);
      const current = snapshot(error.message.slice(error.message.lastIndexOf("\n{") + 1));
      assert.equal(current.activeDialog, undefined);
      assert.ok(!current.elements.some((element) => element.text === "关闭"));
      return true;
    });
    await assert.rejects(driver.click(saveRef), /引用.*已失效.*最新页面状态/s);
    const latest = snapshot(await driver.inspect());
    const editRef = latest.elements.find((element) => element.text === "编辑 FE1")?.ref;
    assert.ok(editRef);
    assert.ok(snapshot(await driver.click(editRef)).activeDialog);
  });
});

test("background targets are blocked while a modal is open, and genuine multiple matches report ambiguity", async () => {
  await withPage(editor.replace("<output", '<button class="save">另一个保存</button><output'), async (driver) => {
    await assert.rejects(driver.click(".save"), /匹配到 2 个可操作元素.*更精确的选择器.*最新页面状态/s);
    await driver.click("#edit");
    await assert.rejects(driver.click("#page-save"), /被当前弹窗遮挡.*最新页面状态/s);
    await driver.click("#close");
    assert.doesNotMatch(snapshot(await driver.inspect()).text, /底层页面已保存/);
  });
});

test("offscreen document controls remain available and Playwright scrolls them into view", async () => {
  await withPage(`<!doctype html><body><div style="height:2500px">长页面</div>
    <button id="footer" onclick="this.textContent='已点击底部按钮'">底部按钮</button></body>`, async (driver, initial) => {
    const footer = initial.elements.find((element) => element.text === "底部按钮");
    assert.ok(footer);
    assert.equal(footer.inViewport, false);
    const after = snapshot(await driver.click(footer.ref));
    assert.equal(after.elements[0].text, "已点击底部按钮");
    assert.equal(after.elements[0].inViewport, true);
  });
});

test("controls below the fold inside a fixed scrollable modal remain accessible", async () => {
  const html = `<!doctype html><body><div role="dialog" aria-modal="true" aria-label="长表单"
    style="position:fixed;inset:20px;overflow:auto;background:white">
    <div style="height:1800px">表单内容</div><button onclick="this.textContent='已保存'">保存长表单</button>
    </div></body>`;
  await withPage(html, async (driver, initial) => {
    assert.equal(initial.activeDialog?.title, "长表单");
    const save = initial.elements.find((element) => element.text === "保存长表单");
    assert.ok(save);
    assert.equal(save.inViewport, false);
    const after = snapshot(await driver.click(save.ref));
    assert.ok(after.elements.some((element) => element.text === "已保存" && element.inViewport));
  });
});

test("native select options and custom validation errors are exposed", async () => {
  await withPage(`<!doctype html><body><label for="protocol">协议</label>
    <select id="protocol"><option value="none">不配置</option><option value="static">静态 IPv4</option></select>
    <div class="cbi-value"><label class="cbi-value-title">网关</label>
      <input class="cbi-input-invalid" title="请输入有效的 IPv4 地址"></div>
    <fieldset disabled><button id="disabled">不可用</button></fieldset></body>`, async (driver, initial) => {
    const select = initial.elements.find((element) => element.controlType === "native-select");
    assert.ok(select);
    assert.equal(select.label, "协议");
    assert.ok(select.options?.some((option) => option.value === "static"));
    assert.deepEqual(initial.validationErrors, [{ label: "网关", message: "请输入有效的 IPv4 地址" }]);
    const changed = snapshot(await driver.select(select.ref, "static"));
    assert.equal(changed.elements.find((element) => element.tag === "select")?.value, "static");
    assert.equal(changed.elements.find((element) => element.text === "不可用")?.disabled, true);
    await assert.rejects(driver.click("#disabled"), /已禁用.*最新页面状态/s);
  });
});

test("dropdown options owned by a modal can be operated when rendered outside it", async () => {
  await withPage(`<!doctype html><body>
    <div role="dialog" aria-modal="true" aria-label="配置" style="position:fixed;inset:20px;background:white;z-index:10">
      <div role="combobox" aria-controls="popup" aria-expanded="true" tabindex="0">选择掩码</div>
    </div>
    <div id="popup" role="listbox" style="position:fixed;top:60px;left:60px;z-index:11">
      <button role="option" onclick="this.setAttribute('aria-selected','true')">255.255.255.0</button>
    </div></body>`, async (driver, initial) => {
    const option = initial.elements.find((element) => element.role === "option");
    assert.ok(option);
    const changed = snapshot(await driver.click(option.ref));
    assert.ok(changed.elements.some((element) => element.role === "option"));
  });
});
