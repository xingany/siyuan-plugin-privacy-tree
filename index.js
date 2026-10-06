"use strict";

const { Plugin, Dialog, showMessage } = require("siyuan");

const STORAGE_NAME = "config.json";
const ICON_ID = "iconPrivacyTree";
const ICON =
    "<symbol id=\"iconPrivacyTree\" viewBox=\"0 0 32 32\">" +
    "<path d=\"M4 3h24a2 2 0 0 1 2 2v22a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm3 8v3h18v-3H7zm0 6v2h12v-2H7zm0 5v2h8v-2H7z\"></path>" +
    "<circle cx=\"22.5\" cy=\"22.5\" r=\"4.2\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.4\"></circle>" +
    "<path d=\"M25.6 25.6l4.4 4.4\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.4\" stroke-linecap=\"round\"></path>" +
    "</symbol>";

const UNNAMED_KEY = "__UNNAMED__";
const RANDOM_CHARS = "机密保密隐去已隐内容不可见此处略过文档信息遮盖";

const DEFAULT_CONFIG = {
    placeholder: "••••••",
    hotkey: "⌃⇧Z",
    showMessage: true,
    maskHeadings: false,
    passwordEnabled: false,
    password: "",
    noEditLock: false,
    idleMinutes: 0,
    idleLock: false,
    collapseTreeMinutes: 0,
    contentEnabled: false,
    contentStyle: "bar",
    contentText: "",
};

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
    });
}

function randomText(len) {
    var n = Math.max(4, Math.min(40, len || 8));
    var s = "";
    for (var i = 0; i < n; i++) {
        s += RANDOM_CHARS[Math.floor(Math.random() * RANDOM_CHARS.length)];
    }
    return s;
}

class PrivacyTreePlugin extends Plugin {
    constructor() {
        super(...arguments);
        this.config = Object.assign({}, DEFAULT_CONFIG);
        this.config.aliases = {};
        this.config.hiddenItems = {};
        this.active = false;
        this.topBarEl = null;
        this.topBarAdded = false;
        this.dialog = null;
        this.pwdDialog = null;
        this.pickerDialog = null;
        this.observer = null;
        this.applyTimer = null;
        this.titleObserver = null;
        this.originalTitle = null;
        this.blockEl = null;
        this.blockKeyHandler = null;
        this.idleTimer = null;
        this.idleBound = false;
        this.treeTimer = null;
        this.collapsedTree = false;
        this.hiddenEls = [];
        this.forceLock = null;
        this.tableDumped = false;
    }

    async onload() {
        try {
            if (window.__siyuanPrivacyTreeCleanup) {
                window.__siyuanPrivacyTreeCleanup();
            }
        } catch (e) {
            /* ignore */
        }
        window.__siyuanPrivacyTreeCleanup = () => {
            try {
                this.stopIdleWatch();
                this.clearTreeTimer();
                this.hideBlockOverlay();
                this.doClear(false);
            } catch (e) {
                /* ignore */
            }
        };
        try {
            this.addIcons(ICON);
            await this.loadConfig();
            this.cleanupLeftovers();
            try {
                this.addCommand({
                    langKey: "togglePrivacyMode",
                    langText: "切换隐私模式（可编辑）",
                    hotkey: this.config.hotkey,
                    callback: () => {
                        this.forceLock = false;
                        this.toggle();
                    },
                });
            } catch (e) {
                console.error("[privacy-tree] 注册命令失败", e);
            }
            try {
                this.addCommand({
                    langKey: "togglePrivacyLocked",
                    langText: "切换隐私模式（不可编辑）",
                    hotkey: "⌃⇧X",
                    callback: () => {
                        this.forceLock = true;
                        this.toggle();
                    },
                });
            } catch (e) {
                console.error("[privacy-tree] 注册命令失败", e);
            }
            this.eventBus.on("open-menu-doctree", this.onDocTreeMenu);
            this.startIdleWatch();
        } catch (e) {
            console.error("[privacy-tree] onload error", e);
        }
        this.ensureTopBar();
    }

    onLayoutReady() {
        this.cleanupLeftovers();
        this.ensureTopBar();
        this.startIdleWatch();
    }

    onunload() {
        try {
            this.eventBus.off("open-menu-doctree", this.onDocTreeMenu);
        } catch (e) {
            /* ignore */
        }
        this.stopIdleWatch();
        this.clearTreeTimer();
        this.hidePasswordDialog();
        this.deactivate(false);
        this.cleanupLeftovers();
        this.active = false;
        if (window.__siyuanPrivacyTreeCleanup) {
            window.__siyuanPrivacyTreeCleanup = null;
        }
    }

    doClear(notify) {
        this.hideBlockOverlay();
        this.hidePasswordDialog();
        this.clearTreeTimer();
        this.collapsedTree = false;
        document.documentElement.classList.remove("privacy-tree-on");
        document.querySelectorAll("[data-privacy-on]").forEach((el) => this.unmaskText(el));
        document.querySelectorAll("[data-privacy-placeholder]").forEach((el) => el.removeAttribute("data-privacy-placeholder"));
        this.clearCovers();
        document.querySelectorAll(".privacy-tree-block").forEach((el) => {
            if (el.parentElement) {
                el.parentElement.removeChild(el);
            }
        });
        this.blockEl = null;
        this.active = false;
        this.stopObserver();
        this.stopTitleGuard();
        this.updateButton();
        this.resetIdle();
        if (notify && this.config.showMessage) {
            showMessage(this.t("cleared", "已清除所有隐私遮罩"), 2500);
        }
    }

    cleanupLeftovers() {
        try {
            if (this.active) {
                return;
            }
            this.doClear(false);
        } catch (e) {
            /* ignore */
        }
    }

    ensureTopBar() {
        if (this.topBarAdded) {
            return;
        }
        try {
            this.topBarEl = this.addTopBar({
                icon: ICON_ID,
                title: this.t("toggle", "切换文档树隐私模式"),
                position: "right",
                callback: () => {
                    this.forceLock = null;
                    this.toggle();
                },
                contextMenu: (menu) => this.buildMenu(menu),
            });
            if (this.topBarEl) {
                this.topBarEl.id = "privacy-tree-topbar";
            }
            this.topBarAdded = true;
            this.updateButton();
        } catch (e) {
            console.error("[privacy-tree] 添加顶栏按钮失败", e);
        }
    }

    onDocTreeMenu = (event) => {
        try {
            const detail = event && event.detail;
            if (!detail || !detail.menu) {
                return;
            }
            detail.menu.addItem({
                id: "privacy-tree-toggle",
                icon: ICON_ID,
                label: this.active ? this.t("menuOff", "关闭文档树隐私模式") : this.t("menuOn", "开启文档树隐私模式"),
                click: () => {
                    this.forceLock = null;
                    this.toggle();
                },
            });
            const elements = detail.elements || [];
            if (elements.length === 1) {
                const el = elements[0];
                const id = this.resolveId(el);
                const textEl = el.querySelector(".b3-list-item__text");
                const title = this.realText(textEl);
                detail.menu.addItem({
                    id: "privacy-tree-alias",
                    icon: "iconEdit",
                    label: this.t("aliasSet", "设置隐私别名"),
                    click: () => this.openAliasDialog(id || UNNAMED_KEY, title || "未命名文档"),
                });
            }
            detail.menu.addItem({
                id: "privacy-tree-clear",
                icon: "iconTrashcan",
                label: this.t("clearAll", "清除所有隐私遮罩"),
                click: () => this.doClear(true),
            });
            detail.menu.addItem({
                id: "privacy-tree-settings",
                icon: "iconSettings",
                label: this.t("settingsTitle", "文档树隐私保护设置"),
                click: () => this.openSettings(),
            });
        } catch (e) {
            console.error("[privacy-tree]", e);
        }
    };

    buildMenu(menu) {
        menu.addItem({
            icon: ICON_ID,
            label: this.active ? this.t("menuOff", "关闭文档树隐私模式") : this.t("menuOn", "开启文档树隐私模式"),
            click: () => {
                this.forceLock = null;
                this.toggle();
            },
        });
        menu.addItem({
            icon: "iconTrashcan",
            label: this.t("clearAll", "清除所有隐私遮罩"),
            click: () => this.doClear(true),
        });
        menu.addItem({
            icon: "iconSettings",
            label: this.t("settingsTitle", "文档树隐私保护设置"),
            click: () => this.openSettings(),
        });
    }

    t(key, fallback) {
        try {
            const value = this.i18n && this.i18n[key];
            return value || fallback;
        } catch (e) {
            return fallback;
        }
    }

    async loadConfig() {
        try {
            const saved = await this.loadData(STORAGE_NAME);
            if (saved && typeof saved === "object" && !saved.code) {
                this.config = Object.assign({}, DEFAULT_CONFIG, saved);
            } else {
                await this.saveData(STORAGE_NAME, this.config);
            }
        } catch (e) {
            console.error("[privacy-tree] 读取配置失败", e);
        }
        if (!this.config.aliases || typeof this.config.aliases !== "object") {
            this.config.aliases = {};
        }
        if (!this.config.hiddenItems || typeof this.config.hiddenItems !== "object") {
            this.config.hiddenItems = {};
        }
    }

    async saveConfig() {
        try {
            await this.saveData(STORAGE_NAME, this.config);
        } catch (e) {
            console.error("[privacy-tree] 保存配置失败", e);
        }
    }

    textNodes(el) {
        const out = [];
        const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let n = walker.nextNode();
        while (n) {
            out.push(n);
            n = walker.nextNode();
        }
        return out;
    }

    realText(el) {
        if (!el) {
            return "";
        }
        const orig = el.getAttribute("data-privacy-orig-text");
        if (orig != null) {
            return orig;
        }
        return el.textContent.trim();
    }

    maskText(el, text) {
        if (!el.hasAttribute("data-privacy-on")) {
            el.setAttribute("data-privacy-original-html", el.innerHTML);
            el.setAttribute("data-privacy-orig-text", el.textContent.trim());
            el.setAttribute("data-privacy-on", "1");
        }
        const nodes = this.textNodes(el);
        if (nodes.length === 0) {
            if (el.textContent !== text) {
                el.appendChild(document.createTextNode(text));
            }
            return;
        }
        nodes.forEach((node, i) => {
            const v = i === 0 ? text : "";
            if (node.nodeValue !== v) {
                node.nodeValue = v;
            }
        });
    }

    unmaskText(el) {
        const html = el.getAttribute("data-privacy-original-html");
        if (html != null) {
            el.innerHTML = html;
        }
        el.removeAttribute("data-privacy-original-html");
        el.removeAttribute("data-privacy-orig-text");
        el.removeAttribute("data-privacy-on");
    }

    resolveId(item) {
        const own = item.getAttribute("data-node-id");
        if (own) {
            return own;
        }
        const dataId = item.getAttribute("data-id");
        if (dataId) {
            return dataId;
        }
        const textEl = item.querySelector(".b3-list-item__text");
        const name = this.realText(textEl);
        if (name) {
            const notebooks = (window.siyuan && window.siyuan.notebooks) || [];
            const nb = notebooks.find((n) => n.name === name);
            if (nb && nb.id) {
                return nb.id;
            }
        }
        return "";
    }

    lookupAlias(id, realText) {
        if (id && this.config.aliases[id]) {
            return this.config.aliases[id];
        }
        if (realText) {
            const found = Object.values(this.config.aliases).find((a) => a && a.title === realText);
            if (found) {
                return found;
            }
        }
        return null;
    }

    mask(alias) {
        return alias && alias.enabled !== false && alias.text ? alias.text : this.config.placeholder || "";
    }

    tabBlockId(tabEl) {
        const init = tabEl.getAttribute("data-initdata");
        if (init) {
            const m = init.match(/"blockId":"([^"]+)"/);
            if (m) {
                return m[1];
            }
        }
        return "";
    }

    visibleWysiwygs() {
        const all = Array.from(document.querySelectorAll(".protyle-wysiwyg"));
        const vis = all.filter((w) => w.getClientRects().length > 0);
        return vis.length ? vis : all;
    }

    activeWysiwyg() {
        const vis = this.visibleWysiwygs();
        const activeWnd = document.querySelector(".layout__wnd--active");
        if (activeWnd) {
            const inWnd = vis.find((w) => activeWnd.contains(w));
            if (inWnd) {
                return inWnd;
            }
        }
        for (let i = 0; i < vis.length; i++) {
            if (vis[i].querySelector(".protyle-title[data-node-id]")) {
                return vis[i];
            }
        }
        return vis[0] || null;
    }

    activeTitle() {
        const wys = this.activeWysiwyg();
        const protyle = wys ? wys.closest(".protyle") : null;
        const t = protyle ? protyle.querySelector(".protyle-title[data-node-id]") : null;
        if (t) {
            return t;
        }
        const visTitles = Array.from(document.querySelectorAll(".protyle-title[data-node-id]")).filter((x) => x.getClientRects().length > 0);
        return visTitles[0] || document.querySelector(".protyle-title[data-node-id]");
    }

    currentDoc() {
        const title = this.activeTitle();
        if (title) {
            return { id: title.getAttribute("data-node-id"), title: this.realText(title) };
        }
        const active = document.querySelector(".layout-tab-bar .item--focus .item__text");
        if (active) {
            const tab = active.closest(".item");
            return { id: tab ? this.tabBlockId(tab) : "", title: this.realText(active) };
        }
        return { id: "", title: "" };
    }

    currentDocName() {
        const doc = this.currentDoc();
        if (doc.id) {
            return this.mask(this.lookupAlias(doc.id, doc.title));
        }
        return this.config.placeholder || "";
    }

    applyAliases() {
        if (!this.active) {
            return;
        }
        this.applyContentCovers();
        document.querySelectorAll(".sy__file .b3-list-item").forEach((item) => {
            const textEl = item.querySelector(".b3-list-item__text");
            if (!textEl) {
                return;
            }
            const id = this.resolveId(item);
            const real = this.realText(textEl);
            this.maskText(textEl, this.mask(this.lookupAlias(id || UNNAMED_KEY, real)));
        });
        document.querySelectorAll(".layout-tab-bar .item .item__text").forEach((textEl) => {
            const tab = textEl.closest(".item");
            const real = this.realText(textEl);
            const id = tab ? this.tabBlockId(tab) : "";
            this.maskText(textEl, this.mask(this.lookupAlias(id, real)));
        });
        document.querySelectorAll(".protyle-breadcrumb__text").forEach((el) => {
            const holder = el.closest("[data-node-id]");
            const real = this.realText(el);
            const id = holder ? holder.getAttribute("data-node-id") : "";
            this.maskText(el, this.mask(this.lookupAlias(id, real)));
        });
        this.applyHeadingMask();
        this.visibleWysiwygs().forEach((wys) => {
            const protyle = wys.closest(".protyle");
            const title = protyle ? protyle.querySelector(".protyle-title") : null;
            if (!title) {
                return;
            }
            const id = title.getAttribute("data-node-id") || "";
            const cover = this.mask(this.lookupAlias(id, this.realText(title)));
            title.setAttribute("data-privacy-cover", cover);
            title.setAttribute("data-privacy-cover-style", "text");
            title.classList.add("privacy-tree-hidden");
            this.hiddenEls.push(title);
        });
        this.applyWindowTitle();
    }

    applyHeadingMask() {
        const docName = this.currentDocName();
        if (this.config.maskHeadings) {
            this.visibleWysiwygs().forEach((wys) => {
                wys.querySelectorAll("[data-type=\"NodeHeading\"]").forEach((h) => {
                    h.setAttribute("data-privacy-cover", docName);
                    h.setAttribute("data-privacy-cover-style", "text");
                    h.classList.add("privacy-tree-hidden");
                    this.hiddenEls.push(h);
                });
            });
            document.querySelectorAll(".sy__outline .b3-list-item__text").forEach((el) => {
                this.maskText(el, docName);
            });
        } else {
            document.querySelectorAll(".sy__outline .b3-list-item__text[data-privacy-on]").forEach((el) => {
                this.unmaskText(el);
            });
        }
    }

    // ---- 内容遮盖 ----

    clearCovers() {
        document.querySelectorAll(".privacy-tree-hidden").forEach((el) => {
            el.classList.remove("privacy-tree-hidden");
            el.removeAttribute("data-privacy-cover");
            el.removeAttribute("data-privacy-cover-style");
        });
        this.hiddenEls = [];
    }

    coverText(el) {
        const style = this.config.contentStyle || "bar";
        if (style === "text") {
            return this.config.contentText || this.config.placeholder || "";
        }
        if (style === "random") {
            return randomText(Math.max(6, (el.textContent || "").trim().length));
        }
        return "";
    }

    findEditorRoot(docId) {
        const vis = this.visibleWysiwygs();
        for (let i = 0; i < vis.length; i++) {
            const protyle = vis[i].closest(".protyle");
            const t = protyle ? protyle.querySelector(".protyle-title[data-node-id]") : null;
            if (t && t.getAttribute("data-node-id") === docId) {
                return vis[i];
            }
        }
        const all = Array.from(document.querySelectorAll(".protyle-wysiwyg"));
        for (let i = 0; i < all.length; i++) {
            const protyle = all[i].closest(".protyle");
            const t = protyle ? protyle.querySelector(".protyle-title[data-node-id]") : null;
            if (t && t.getAttribute("data-node-id") === docId) {
                return all[i];
            }
        }
        return null;
    }

    isCoverableBlock(el) {
        const type = el.getAttribute("data-type") || "";
        if (!type || type === "NodeHeading") {
            return false;
        }
        if (type.indexOf("Table") > -1 || el.classList.contains("table")) {
            return false; // 表格单独处理
        }
        return !!el.querySelector(":scope > [contenteditable]");
    }

    hideElement(el, text, style) {
        if (!el) {
            return;
        }
        el.setAttribute("data-privacy-cover", text || "");
        el.setAttribute("data-privacy-cover-style", style || "bar");
        el.classList.add("privacy-tree-hidden");
        this.hiddenEls.push(el);
    }

    dumpTable(table) {
        if (this.tableDumped) {
            return;
        }
        this.tableDumped = true;
        try {
            this.saveData("_table.json", table.outerHTML.slice(0, 6000));
        } catch (e) {
            /* ignore */
        }
    }

    coverTable(table, style) {
        // 优先盖单元格内的可编辑体；否则盖单元格；再否则盖整表
        let targets = Array.from(table.querySelectorAll("[contenteditable]"));
        if (targets.length === 0) {
            targets = Array.from(table.querySelectorAll("td, th, .table__cell, [data-type*=\"TableCell\"]"));
        }
        if (targets.length === 0) {
            targets = [table];
        }
        targets.forEach((t) => this.hideElement(t, this.coverText(t), style));
        this.dumpTable(table);
    }

    isTableBlock(el) {
        const type = el.getAttribute("data-type") || "";
        return type.indexOf("Table") > -1 || el.classList.contains("table");
    }

    coverWholeDoc(docEl, style) {
        docEl.querySelectorAll("[data-node-id]").forEach((b) => {
            if (this.isTableBlock(b)) {
                this.coverTable(b, style);
                return;
            }
            if (this.isCoverableBlock(b)) {
                this.hideElement(b, this.coverText(b), style);
            }
        });
    }

    applyContentCovers() {
        this.clearCovers();
        if (!this.active || !this.config.contentEnabled) {
            return;
        }
        const hidden = this.config.hiddenItems || {};
        const ids = Object.keys(hidden).filter((k) => hidden[k] && hidden[k].enabled !== false);
        if (ids.length === 0) {
            return;
        }
        const style = this.config.contentStyle || "bar";
        ids.forEach((id) => {
            const docEl = this.findEditorRoot(id);
            if (docEl) {
                this.coverWholeDoc(docEl, style);
                return;
            }
            const block = document.querySelector(".protyle-wysiwyg [data-node-id=\"" + id + "\"]");
            if (block) {
                if (this.isTableBlock(block)) {
                    this.coverTable(block, style);
                } else {
                    this.hideElement(block, this.coverText(block), style);
                }
            }
        });
    }

    applyWindowTitle() {
        if (!this.active) {
            return;
        }
        const masked = this.currentDocName();
        if (document.title !== masked) {
            document.title = masked;
        }
    }

    startTitleGuard() {
        if (this.titleObserver) {
            return;
        }
        this.originalTitle = document.title;
        this.titleObserver = new MutationObserver(() => this.applyWindowTitle());
        this.titleObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
        this.applyWindowTitle();
    }

    stopTitleGuard() {
        if (this.titleObserver) {
            this.titleObserver.disconnect();
            this.titleObserver = null;
        }
        if (this.originalTitle != null) {
            let restored = this.originalTitle;
            const active = document.querySelector(".layout-tab-bar .item--focus .item__text");
            const real = this.realText(active);
            const idx = restored.indexOf(" - ");
            if (real && idx > -1) {
                restored = real + restored.slice(idx);
            }
            document.title = restored;
            this.originalTitle = null;
        }
    }

    startObserver() {
        if (this.observer) {
            return;
        }
        this.observer = new MutationObserver((records) => {
            for (let i = 0; i < records.length; i++) {
                const t = records[i].target;
                if (t && t.nodeType === 1 && (t.closest(".sy__file") || t.closest(".protyle"))) {
                    this.scheduleApply();
                    return;
                }
            }
        });
        this.observer.observe(document.body, { childList: true, subtree: true });
    }

    stopObserver() {
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
        if (this.applyTimer) {
            clearTimeout(this.applyTimer);
            this.applyTimer = null;
        }
    }

    scheduleApply() {
        if (!this.active || this.applyTimer) {
            return;
        }
        this.applyTimer = setTimeout(() => {
            this.applyTimer = null;
            if (!this.active) {
                return;
            }
            this.applyAliases();
        }, 400);
    }

    lockEnabledNow() {
        if (this.forceLock !== null) {
            return this.forceLock;
        }
        return !!this.config.noEditLock;
    }

    activate(auto) {
        this.doClear(false);
        this.tableDumped = false;
        document.documentElement.classList.add("privacy-tree-on");
        this.active = true;
        this.updateButton();
        this.applyAliases();
        this.startObserver();
        this.startTitleGuard();
        this.startTreeTimer();
        const lock = this.lockEnabledNow();
        this.forceLock = null;
        if (lock) {
            this.showBlockOverlay();
        }
        if (this.config.showMessage) {
            if (auto) {
                showMessage(this.t("onAuto", "空闲自动进入隐私模式（点击顶栏图标或按 Ctrl+Shift+Z 退出）"), 3000);
            } else {
                showMessage(this.t("on", "已开启文档树隐私模式"), 2000);
            }
        }
    }

    deactivate(notify) {
        const wasActive = this.active;
        this.doClear(false);
        if (notify !== false && wasActive && this.config.showMessage) {
            showMessage(this.t("off", "已关闭文档树隐私模式"), 2000);
        }
    }

    toggle() {
        if (this.active) {
            this.requestUnlock();
        } else {
            this.activate();
        }
    }

    updateButton() {
        if (!this.topBarEl) {
            return;
        }
        this.topBarEl.classList.toggle("privacy-tree-active", this.active);
    }

    leftDock() {
        try {
            return window.siyuan && window.siyuan.layout && window.siyuan.layout.leftDock;
        } catch (e) {
            return null;
        }
    }

    isFileTreeOpen() {
        return !!document.querySelector("#dockLeft .dock__item[data-type=\"file\"].dock__item--active");
    }

    collapseFileTree() {
        if (!this.isFileTreeOpen()) {
            return;
        }
        const dock = this.leftDock();
        if (dock && typeof dock.toggleModel === "function") {
            dock.toggleModel("file", false, true);
            this.collapsedTree = true;
        } else {
            const item = document.querySelector("#dockLeft .dock__item[data-type=\"file\"].dock__item--active");
            if (item) {
                item.click();
                this.collapsedTree = true;
            }
        }
    }

    restoreFileTree() {
        if (!this.collapsedTree) {
            return;
        }
        this.collapsedTree = false;
        const dock = this.leftDock();
        if (dock && typeof dock.toggleModel === "function" && !this.isFileTreeOpen()) {
            dock.toggleModel("file", true, true);
        }
    }

    startTreeTimer() {
        this.clearTreeTimer();
        const m = Number(this.config.collapseTreeMinutes);
        if (m > 0) {
            this.treeTimer = setTimeout(() => {
                this.treeTimer = null;
                this.collapseFileTree();
            }, m * 60000);
        }
    }

    clearTreeTimer() {
        if (this.treeTimer) {
            clearTimeout(this.treeTimer);
            this.treeTimer = null;
        }
    }

    requestUnlock() {
        if (!this.config.passwordEnabled || !this.config.password) {
            this.deactivate();
            return;
        }
        this.promptUnlock();
    }

    hidePasswordDialog() {
        if (this.pwdDialog) {
            this.pwdDialog.destroy();
            this.pwdDialog = null;
        }
    }

    promptUnlock() {
        if (this.pwdDialog) {
            return;
        }
        const plugin = this;
        const dlg = new Dialog({
            title: this.t("unlockTitle", "解锁"),
            width: "380px",
            content:
                "<div style=\"padding:8px 4px;\">" +
                "<div class=\"b3-label__text\" style=\"margin-bottom:8px;\">" + escapeHtml(this.t("unlockDesc", "输入密码以退出隐私模式")) + "</div>" +
                "<input id=\"privacy-tree-pwd\" type=\"password\" class=\"b3-text-field fn__block\" />" +
                "<div class=\"b3-dialog__action\" style=\"display:flex;justify-content:flex-end;gap:8px;margin-top:14px;\">" +
                "<button id=\"privacy-tree-pwd-cancel\" class=\"b3-button b3-button--cancel\">" + this.t("cancel", "取消") + "</button>" +
                "<button id=\"privacy-tree-pwd-btn\" class=\"b3-button b3-button--text\">" + this.t("unlock", "解锁") + "</button>" +
                "</div></div>",
            destroyCallback: () => {
                this.pwdDialog = null;
                this.resetIdle();
            },
        });
        this.pwdDialog = dlg;
        const input = dlg.element.querySelector("#privacy-tree-pwd");
        const tryIt = () => {
            if (input.value === plugin.config.password) {
                plugin.hidePasswordDialog();
                plugin.deactivate();
            } else {
                input.value = "";
                input.placeholder = plugin.t("wrongPassword", "密码错误");
            }
        };
        dlg.element.querySelector("#privacy-tree-pwd-btn").addEventListener("click", tryIt);
        dlg.element.querySelector("#privacy-tree-pwd-cancel").addEventListener("click", () => dlg.destroy());
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                tryIt();
            }
        });
        setTimeout(() => input.focus(), 60);
    }

    showBlockOverlay() {
        if (this.blockEl) {
            return;
        }
        const el = document.createElement("div");
        el.className = "privacy-tree-block";
        const hint = document.createElement("div");
        hint.className = "privacy-tree-block__hint";
        hint.textContent = this.t("blockHint", "隐私模式已锁定，点击输入密码解锁");
        el.appendChild(hint);
        el.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.promptUnlock();
        });
        document.body.appendChild(el);
        this.blockEl = el;

        this.blockKeyHandler = (e) => {
            if (!this.blockEl) {
                return;
            }
            if (this.pwdDialog && this.pwdDialog.element && this.pwdDialog.element.contains(e.target)) {
                return;
            }
            e.stopPropagation();
            if (e.type === "keydown") {
                e.preventDefault();
                this.promptUnlock();
            }
        };
        document.addEventListener("keydown", this.blockKeyHandler, true);
        document.addEventListener("keyup", this.blockKeyHandler, true);
    }

    hideBlockOverlay() {
        if (this.blockEl && this.blockEl.parentElement) {
            this.blockEl.parentElement.removeChild(this.blockEl);
        }
        this.blockEl = null;
        if (this.blockKeyHandler) {
            document.removeEventListener("keydown", this.blockKeyHandler, true);
            document.removeEventListener("keyup", this.blockKeyHandler, true);
            this.blockKeyHandler = null;
        }
    }

    startIdleWatch() {
        if (this.idleBound) {
            this.resetIdle();
            return;
        }
        this.idleBound = true;
        this.idleHandler = () => this.resetIdle();
        ["mousemove", "mousedown", "keydown", "wheel", "touchstart", "scroll"].forEach((ev) => {
            document.addEventListener(ev, this.idleHandler, true);
        });
        this.resetIdle();
    }

    stopIdleWatch() {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        if (this.idleBound && this.idleHandler) {
            ["mousemove", "mousedown", "keydown", "wheel", "touchstart", "scroll"].forEach((ev) => {
                document.removeEventListener(ev, this.idleHandler, true);
            });
        }
        this.idleBound = false;
    }

    resetIdle() {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        const minutes = Number(this.config.idleMinutes);
        if (!this.active && minutes > 0 && !this.pwdDialog) {
            this.idleTimer = setTimeout(() => {
                this.idleTimer = null;
                if (!this.active) {
                    this.forceLock = !!this.config.idleLock;
                    this.activate(true);
                }
            }, minutes * 60000);
        }
    }

    openAliasDialog(id, title) {
        const plugin = this;
        if (this.dialog) {
            this.dialog.destroy();
            this.dialog = null;
        }
        const alias = this.config.aliases[id];
        const dialog = new Dialog({
            title: this.t("aliasTitle", "设置隐私别名"),
            width: "480px",
            content:
                "<div style=\"padding:8px 4px;\">" +
                "<div class=\"b3-label__text\" style=\"margin-bottom:8px;\">" + escapeHtml(title || id) + "</div>" +
                "<input id=\"privacy-tree-alias-input\" class=\"b3-text-field fn__block\" />" +
                "<label class=\"privacy-tree-row\" style=\"cursor:pointer;margin-top:8px;\">" +
                "<input id=\"privacy-tree-alias-enabled\" type=\"checkbox\" class=\"b3-switch\" />" +
                "<span>" + this.t("aliasEnable", "启用单独别名") + "</span></label>" +
                "<div class=\"privacy-tree-footer\">" +
                "<button id=\"privacy-tree-alias-clear\" class=\"b3-button b3-button--cancel\">" + this.t("aliasClear", "清除别名") + "</button>" +
                "<button id=\"privacy-tree-alias-save\" class=\"b3-button b3-button--text\">" + this.t("save", "保存") + "</button>" +
                "</div></div>",
        });
        this.dialog = dialog;
        const input = dialog.element.querySelector("#privacy-tree-alias-input");
        const enabledInput = dialog.element.querySelector("#privacy-tree-alias-enabled");
        input.placeholder = this.config.placeholder || "";
        input.value = (alias && alias.text) || "";
        enabledInput.checked = alias ? alias.enabled !== false : true;
        dialog.element.querySelector("#privacy-tree-alias-clear").addEventListener("click", async () => {
            delete plugin.config.aliases[id];
            await plugin.saveConfig();
            plugin.applyAliases();
            showMessage(plugin.t("aliasCleared", "已清除别名"), 2000);
            plugin.dialog = null;
            dialog.destroy();
        });
        dialog.element.querySelector("#privacy-tree-alias-save").addEventListener("click", async () => {
            const text = input.value.trim();
            if (!text) {
                delete plugin.config.aliases[id];
            } else {
                plugin.config.aliases[id] = { text: text, title: title || id, enabled: enabledInput.checked };
            }
            await plugin.saveConfig();
            plugin.applyAliases();
            showMessage(plugin.t("aliasSaved", "别名已保存"), 2000);
            plugin.dialog = null;
            dialog.destroy();
        });
    }

    openContentPicker() {
        const plugin = this;
        const rootEl = this.activeWysiwyg();
        if (!rootEl) {
            showMessage(this.t("pickNoDoc", "请先打开一个文档再选择要隐藏的内容"), 3000, "error");
            return;
        }
        if (this.pickerDialog) {
            this.pickerDialog.destroy();
            this.pickerDialog = null;
        }
        const doc = this.currentDoc();
        const docId = doc.id;
        const hidden = this.config.hiddenItems || {};
        const all = Array.from(rootEl.querySelectorAll(":scope > [data-node-id]"));
        const blocks = all.filter((b) => b.getAttribute("data-type") !== "NodeHeading");
        const headingCount = all.length - blocks.length;
        const lines = [];
        lines.push("<div style=\"display:flex;flex-direction:column;max-height:70vh;\">");
        lines.push("<div style=\"flex:1;overflow:auto;padding:2px 6px 8px;\">");
        lines.push("<div class=\"privacy-tree-hint\" style=\"margin-bottom:6px;\">" + this.t("pickCur", "当前文档：") + escapeHtml(doc.title || docId) + "</div>");
        if (docId) {
            lines.push("<label class=\"privacy-tree-row\" style=\"cursor:pointer;font-weight:600;\">");
            lines.push("<input type=\"checkbox\" class=\"pt-pick\" data-id=\"" + escapeHtml(docId) + "\"" + (hidden[docId] ? " checked" : "") + " />");
            lines.push("<span>" + this.t("hideWholeDoc", "整篇正文") + "</span></label>");
            lines.push("<div style=\"border-top:1px solid var(--b3-border-color);margin:6px 0;\"></div>");
        }
        if (blocks.length === 0) {
            lines.push("<div class=\"privacy-tree-hint\">" + this.t("pickEmpty", "当前文档没有可选的正文块") + "</div>");
        } else {
            blocks.forEach((b) => {
                const id = b.getAttribute("data-node-id");
                const type = (b.getAttribute("data-type") || "").replace("Node", "");
                const editable = b.querySelector("[contenteditable]") || b;
                const text = (editable.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
                lines.push("<label class=\"privacy-tree-row\" style=\"cursor:pointer;\">");
                lines.push("<input type=\"checkbox\" class=\"pt-pick\" data-id=\"" + escapeHtml(id) + "\"" + (hidden[id] ? " checked" : "") + " />");
                lines.push("<span class=\"privacy-tree-hint\" style=\"min-width:76px;\">" + escapeHtml(type) + "</span>");
                lines.push("<span class=\"fn__flex-1\" style=\"overflow:hidden;text-overflow:ellipsis;white-space:nowrap;\">" + escapeHtml(text || "空") + "</span></label>");
            });
        }
        if (headingCount > 0) {
            lines.push("<div class=\"privacy-tree-hint\" style=\"margin-top:6px;\">" + this.t("pickHeadingTip", "（标题请用「标题遮盖」设置，此处已排除）") + "</div>");
        }
        lines.push("</div>");
        lines.push("<div class=\"privacy-tree-footer\">");
        lines.push("<button id=\"pt-pick-cancel\" class=\"b3-button b3-button--cancel\">" + this.t("cancel", "取消") + "</button>");
        lines.push("<button id=\"pt-pick-save\" class=\"b3-button b3-button--text\">" + this.t("save", "保存") + "</button>");
        lines.push("</div></div>");

        const dlg = new Dialog({
            title: this.t("pickTitle", "选择要隐藏的正文内容（当前文档）"),
            width: "600px",
            content: lines.join(""),
        });
        this.pickerDialog = dlg;
        dlg.element.querySelector("#pt-pick-cancel").addEventListener("click", () => {
            plugin.pickerDialog = null;
            dlg.destroy();
        });
        dlg.element.querySelector("#pt-pick-save").addEventListener("click", async () => {
            dlg.element.querySelectorAll(".pt-pick").forEach((cb) => {
                const id = cb.getAttribute("data-id");
                if (!id) {
                    return;
                }
                if (cb.checked) {
                    plugin.config.hiddenItems[id] = { enabled: true };
                } else {
                    delete plugin.config.hiddenItems[id];
                }
            });
            await plugin.saveConfig();
            plugin.applyContentCovers();
            showMessage(plugin.t("saved", "设置已保存"), 2000);
            plugin.pickerDialog = null;
            dlg.destroy();
        });
    }

    buildCard(num, title, body) {
        return "<div class=\"privacy-tree-card\"><div class=\"privacy-tree-card__title\"><span class=\"privacy-tree-card__num\">" + escapeHtml(num) + "</span>" + escapeHtml(title) + "</div>" + body + "</div>";
    }

    buildGroup(num, title, cards) {
        return "<div class=\"privacy-tree-group\"><div class=\"privacy-tree-group__title\"><span class=\"privacy-tree-group__num\">" + escapeHtml(num) + "</span>" + escapeHtml(title) + "</div>" +
            "<div class=\"privacy-tree-group__body\">" + cards + "</div></div>";
    }

    openSettings() {
        const plugin = this;
        if (this.dialog) {
            this.dialog.destroy();
            this.dialog = null;
        }

        let unnamedCount = 0;
        document.querySelectorAll(".sy__file .b3-list-item").forEach((item) => {
            if (!this.resolveId(item)) {
                unnamedCount++;
            }
        });
        const hidden = this.config.hiddenItems || {};
        const hiddenCount = Object.keys(hidden).filter((k) => hidden[k] && hidden[k].enabled !== false).length;

        const entries = Object.entries(this.config.aliases);
        const chipLines = [];
        if (entries.length === 0) {
            chipLines.push("<div class=\"b3-label__text privacy-tree-hint\">" + this.t("aliasNone", "暂无别名") + "</div>");
        } else {
            entries.forEach((pair) => {
                const id = pair[0];
                const alias = pair[1] || {};
                const title = alias.title || id;
                const off = alias.enabled === false ? this.t("aliasOff", "（已关闭）") : "";
                chipLines.push("<span style=\"display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:14px;background:var(--b3-theme-surface);margin:0 6px 6px 0;font-size:12px;\">");
                chipLines.push("<span>" + escapeHtml(title) + " → " + escapeHtml(alias.text || "") + escapeHtml(off) + "</span>");
                chipLines.push("<span class=\"privacy-tree-alias-remove\" data-id=\"" + escapeHtml(id) + "\" style=\"cursor:pointer;opacity:.55;\">x</span>");
                chipLines.push("</span>");
            });
        }

        const notebooks = (window.siyuan && window.siyuan.notebooks) || [];
        const nbLines = [];
        if (notebooks.length === 0) {
            nbLines.push("<div class=\"b3-label__text privacy-tree-hint\">" + this.t("nbNone", "未检测到笔记本") + "</div>");
        } else {
            notebooks.forEach((nb) => {
                const alias = this.config.aliases[nb.id];
                nbLines.push("<div class=\"privacy-tree-row\">");
                nbLines.push("<span class=\"fn__flex-1 b3-label__text\" style=\"overflow:hidden;text-overflow:ellipsis;white-space:nowrap;\">" + escapeHtml(nb.name) + "</span>");
                nbLines.push("<input type=\"checkbox\" class=\"b3-switch privacy-tree-nb-toggle\" data-id=\"" + escapeHtml(nb.id) + "\"" + (alias && alias.enabled !== false ? " checked" : "") + " />");
                nbLines.push("<input class=\"b3-text-field privacy-tree-nb-input\" data-id=\"" + escapeHtml(nb.id) + "\" data-name=\"" + escapeHtml(nb.name) + "\" style=\"width:180px;\" value=\"" + escapeHtml((alias && alias.text) || "") + "\" />");
                nbLines.push("</div>");
            });
        }

        const doc = this.currentDoc();
        const docAlias = doc.id ? this.config.aliases[doc.id] : null;
        const docHiddenNow = !!(doc.id && hidden[doc.id] && hidden[doc.id].enabled !== false);
        const docNowHtml = doc.id ? ("<div class=\"privacy-tree-hint\" style=\"margin-bottom:6px;\">" + this.t("curDocNow", "当前文档：") + escapeHtml(doc.title || doc.id) + "</div>") : "";

        let bodyCurDoc;
        if (!doc.id) {
            bodyCurDoc = "<div class=\"privacy-tree-hint\">" + this.t("curDocNone", "当前没有打开的文档") + "</div>";
        } else {
            bodyCurDoc =
                docNowHtml +
                "<div class=\"privacy-tree-row\">" +
                "<input type=\"checkbox\" class=\"b3-switch\" id=\"privacy-tree-curdoc-toggle\"" + (docAlias && docAlias.enabled !== false ? " checked" : "") + " />" +
                "<input id=\"privacy-tree-curdoc-input\" class=\"b3-text-field fn__flex-1\" value=\"" + escapeHtml((docAlias && docAlias.text) || "") + "\" />" +
                "</div>";
        }

        const styleSel = (v) => (this.config.contentStyle === v ? " selected" : "");
        const btnText = this.active ? this.t("btnOff", "关闭隐私模式") : this.t("btnOn", "开启隐私模式");
        const stateText = this.active ? this.t("stateOn", "已开启") : this.t("stateOff", "已关闭");
        const pickedText = hiddenCount > 0 ? (this.t("pickedCount", "已选 ") + hiddenCount + " 项") : this.t("pickedNone", "尚未选择任何内容");

        const bodyMode =
            "<div class=\"privacy-tree-row\">" +
            "<button id=\"privacy-tree-toggle-btn\" class=\"b3-button b3-button--outline privacy-tree-togglebtn\">" + escapeHtml(btnText) + "</button>" +
            "<span class=\"b3-label__text\" id=\"privacy-tree-mode-state\" style=\"opacity:.7;\">" + escapeHtml(this.t("statePrefix", "当前状态：") + stateText) + "</span>" +
            "</div>" +
            "<div class=\"privacy-tree-hint\">" + this.t("modeHotkeyHint", "快捷键：Ctrl+Shift+Z 隐藏可编辑；Ctrl+Shift+X 隐藏不可编辑。") + "</div>" +
            "<div class=\"privacy-tree-row\" style=\"margin-top:6px;\">" +
            "<button id=\"privacy-tree-clear-btn\" class=\"b3-button b3-button--outline\">" + this.t("clearAll", "清除所有隐私遮罩") + "</button></div>";

        const bodyDefault =
            "<input id=\"privacy-tree-placeholder\" class=\"b3-text-field fn__block\" />" +
            "<div class=\"privacy-tree-hint\">" + this.t("placeholderDesc", "没有别名或未启用的条目都用它替代") + "</div>";

        const unamedAlias = this.config.aliases[UNNAMED_KEY];
        const bodyUnnamed =
            "<div class=\"privacy-tree-hint\" style=\"margin-bottom:6px;\">" + this.t("unnamedDesc", "无法解析 id 的条目（如「未命名文档」）。当前共 ") + unnamedCount + " 条</div>" +
            "<div class=\"privacy-tree-row\">" +
            "<input type=\"checkbox\" class=\"b3-switch privacy-tree-unamed-toggle\"" + (unamedAlias && unamedAlias.enabled === false ? "" : " checked") + " />" +
            "<input id=\"privacy-tree-unamed-input\" class=\"b3-text-field fn__flex-1\" value=\"" + escapeHtml((unamedAlias && unamedAlias.text) || "") + "\" />" +
            "</div>";

        const bodyHeadings =
            "<label class=\"privacy-tree-row\" style=\"cursor:pointer;\">" +
            "<input id=\"privacy-tree-headings\" type=\"checkbox\" class=\"b3-switch\" />" +
            "<span>" + this.t("maskHeadingsLabel", "遮盖正文章节标题（h1-h6）与大纲") + "</span></label>" +
            "<div class=\"privacy-tree-hint\">" + this.t("maskHeadingsDesc", "标题显示为当前文档的别名（无别名则用默认名称）。") + "</div>";

        const bodyContent =
            "<label class=\"privacy-tree-row\" style=\"cursor:pointer;font-weight:600;\">" +
            "<input id=\"privacy-tree-curdoc-hide\" type=\"checkbox\" class=\"b3-switch\"" + (docHiddenNow ? " checked" : "") + " />" +
            "<span>" + this.t("curDocHideLabel", "隐藏当前整篇文档正文") + "</span></label>" +
            "<div class=\"privacy-tree-hint\" style=\"margin-bottom:6px;\">" + this.t("curDocHideHint", "逐条遮盖当前文档的正文块（表格逐格遮盖）。") + "</div>" +
            "<label class=\"privacy-tree-row\" style=\"cursor:pointer;\">" +
            "<input id=\"privacy-tree-content-enable\" type=\"checkbox\" class=\"b3-switch\" />" +
            "<span>" + this.t("contentEnableLabel", "启用正文内容遮盖（不含标题）") + "</span></label>" +
            "<div class=\"privacy-tree-row\"><span style=\"min-width:56px;font-size:13px;\">" + this.t("contentStyleLabel", "遮盖形式") + "</span>" +
            "<select id=\"privacy-tree-content-style\" class=\"b3-select\">" +
            "<option value=\"bar\"" + styleSel("bar") + ">" + this.t("styleBar", "圆角矩形条（加载样式）") + "</option>" +
            "<option value=\"blank\"" + styleSel("blank") + ">" + this.t("styleBlank", "空白") + "</option>" +
            "<option value=\"text\"" + styleSel("text") + ">" + this.t("styleText", "指定文字") + "</option>" +
            "<option value=\"random\"" + styleSel("random") + ">" + this.t("styleRandom", "随机文字") + "</option>" +
            "</select></div>" +
            "<div class=\"privacy-tree-row\"><span style=\"min-width:56px;font-size:13px;\">" + this.t("contentTextLabel", "指定文字") + "</span>" +
            "<input id=\"privacy-tree-content-text\" class=\"b3-text-field fn__flex-1\" />" +
            "</div>" +
            "<div class=\"privacy-tree-row\" style=\"margin-top:6px;\">" +
            "<button id=\"privacy-tree-pick\" class=\"b3-button b3-button--outline\">" + this.t("pickBtn", "选择要隐藏的正文内容") + "</button>" +
            "<span class=\"b3-label__text\" style=\"opacity:.7;\">" + escapeHtml(pickedText) + "</span></div>" +
            "<div class=\"privacy-tree-hint\">" + this.t("contentHint", "只针对当前文档的正文（段落/列表/表格等，不含标题）。") + "</div>";

        const bodyLock =
            "<label class=\"privacy-tree-row\" style=\"cursor:pointer;\">" +
            "<input id=\"privacy-tree-password-enable\" type=\"checkbox\" class=\"b3-switch\" />" +
            "<span>" + this.t("passwordEnableLabel", "退出隐私模式需要密码") + "</span></label>" +
            "<div class=\"privacy-tree-row\"><span style=\"min-width:56px;font-size:13px;\">" + this.t("lockPasswordLabel", "密码") + "</span>" +
            "<input id=\"privacy-tree-lock-password\" type=\"password\" class=\"b3-text-field fn__flex-1\" />" +
            "</div>";

        const bodyNoEdit =
            "<label class=\"privacy-tree-row\" style=\"cursor:pointer;\">" +
            "<input id=\"privacy-tree-noedit\" type=\"checkbox\" class=\"b3-switch\" />" +
            "<span>" + this.t("noEditLabel", "不可编辑：点击任意处都需密码才能操作") + "</span></label>" +
            "<div class=\"privacy-tree-hint\">" + this.t("noEditHint", "页面仍显示；也可用 Ctrl+Shift+X 临时以不可编辑方式开启。") + "</div>";

        const bodyIdle =
            "<div class=\"privacy-tree-row\">" +
            "<input id=\"privacy-tree-idle\" type=\"number\" min=\"0\" step=\"1\" class=\"b3-text-field\" style=\"width:90px;\" />" +
            "<span class=\"b3-label__text\">" + this.t("idleUnit", "分钟未操作后自动进入隐私模式（0=关闭）") + "</span>" +
            "</div>" +
            "<label class=\"privacy-tree-row\" style=\"cursor:pointer;\">" +
            "<input id=\"privacy-tree-idle-lock\" type=\"checkbox\" class=\"b3-switch\" />" +
            "<span>" + this.t("idleLockLabel", "自动进入时不可编辑（点击才弹密码框）") + "</span></label>";

        const bodyTree =
            "<div class=\"privacy-tree-row\">" +
            "<input id=\"privacy-tree-tree-minutes\" type=\"number\" min=\"0\" step=\"1\" class=\"b3-text-field\" style=\"width:90px;\" />" +
            "<span class=\"b3-label__text\">" + this.t("treeUnit", "分钟（进入隐私模式后）自动收起左侧文档树（0=关闭）") + "</span>" +
            "</div>" +
            "<div class=\"privacy-tree-hint\">" + this.t("treeHint", "收起文档树可避免暴露文档数量。退出时自动展开。") + "</div>";

        const bodyShortcut =
            "<input id=\"privacy-tree-hotkey\" class=\"b3-text-field fn__block\" />" +
            "<label class=\"privacy-tree-row\" style=\"cursor:pointer;margin-top:8px;\">" +
            "<input id=\"privacy-tree-toast\" type=\"checkbox\" class=\"b3-switch\" />" +
            "<span>" + this.t("toastLabel", "切换时显示提示") + "</span></label>";

        const h = [];
        h.push("<div style=\"display:flex;flex-direction:column;max-height:72vh;\">");
        h.push("<div style=\"flex:1;overflow:auto;padding:2px 8px 8px;\">");
        h.push("<div class=\"privacy-tree-settings\">");

        h.push(this.buildGroup("1", this.t("grpOverview", "隐私模式"),
            this.buildCard("1.1", this.t("secMode", "开关与状态"), bodyMode)));

        h.push(this.buildGroup("2", this.t("grpName", "名称遮盖"),
            this.buildCard("2.1", this.t("secDefault", "默认名称"), bodyDefault) +
            this.buildCard("2.2", this.t("nbLabel", "笔记本（项目）别名"), "<div class=\"privacy-tree-hint\" style=\"margin-bottom:4px;\">" + this.t("nbDesc", "左侧开关是否启用；右边填显示名称") + "</div>" + nbLines.join("")) +
            this.buildCard("2.3", this.t("curDocSec", "当前文档显示名"), bodyCurDoc) +
            this.buildCard("2.4", this.t("unnamedLabel", "未命名文档别名"), bodyUnnamed) +
            this.buildCard("2.5", this.t("aliasLabel", "其他文档别名"), "<div class=\"privacy-tree-hint\" style=\"margin-bottom:6px;\">" + this.t("aliasDesc", "在文档树中右键某个文档即可设置") + "</div>" + "<div class=\"privacy-tree-alias-list\">" + chipLines.join("") + "</div>")));

        h.push(this.buildGroup("3", this.t("grpContent", "内容遮盖"),
            this.buildCard("3.1", this.t("secHeadings", "标题遮盖（h1-h6）"), bodyHeadings) +
            this.buildCard("3.2", this.t("contentSec", "正文内容遮盖（非标题）"), bodyContent)));

        h.push(this.buildGroup("4", this.t("grpSecurity", "安全与自动"),
            this.buildCard("4.1", this.t("lockSec", "密码解锁"), bodyLock) +
            this.buildCard("4.2", this.t("noEditSec", "不可编辑"), bodyNoEdit) +
            this.buildCard("4.3", this.t("idleSec", "空闲自动进入"), bodyIdle) +
            this.buildCard("4.4", this.t("treeSec", "自动收起文档树"), bodyTree)));

        h.push(this.buildGroup("5", this.t("grpOther", "其它"),
            this.buildCard("5.1", this.t("secShortcut", "快捷键与提示"), bodyShortcut)));

        h.push("</div></div>");
        h.push("<div class=\"privacy-tree-footer\">");
        h.push("<button id=\"privacy-tree-cancel\" class=\"b3-button b3-button--cancel\">" + this.t("cancel", "取消") + "</button>");
        h.push("<button id=\"privacy-tree-save\" class=\"b3-button b3-button--text\">" + this.t("save", "保存") + "</button>");
        h.push("</div></div>");

        const dialog = new Dialog({
            title: this.t("settingsTitle", "文档树隐私保护设置"),
            width: "700px",
            content: h.join(""),
        });
        this.dialog = dialog;
        const root = dialog.element;
        const placeholderInput = root.querySelector("#privacy-tree-placeholder");
        const hotkeyInput = root.querySelector("#privacy-tree-hotkey");
        const toastInput = root.querySelector("#privacy-tree-toast");
        const headingsInput = root.querySelector("#privacy-tree-headings");
        const passwordEnableInput = root.querySelector("#privacy-tree-password-enable");
        const passwordInput = root.querySelector("#privacy-tree-lock-password");
        const noEditInput = root.querySelector("#privacy-tree-noedit");
        const idleInput = root.querySelector("#privacy-tree-idle");
        const idleLockInput = root.querySelector("#privacy-tree-idle-lock");
        const treeInput = root.querySelector("#privacy-tree-tree-minutes");
        const contentEnableInput = root.querySelector("#privacy-tree-content-enable");
        const contentStyleInput = root.querySelector("#privacy-tree-content-style");
        const contentTextInput = root.querySelector("#privacy-tree-content-text");
        const curDocHideInput = root.querySelector("#privacy-tree-curdoc-hide");
        placeholderInput.value = this.config.placeholder;
        hotkeyInput.value = this.config.hotkey;
        toastInput.checked = !!this.config.showMessage;
        headingsInput.checked = !!this.config.maskHeadings;
        passwordEnableInput.checked = !!this.config.passwordEnabled;
        passwordInput.value = this.config.password || "";
        noEditInput.checked = !!this.config.noEditLock;
        idleInput.value = String(Number(this.config.idleMinutes) || 0);
        idleLockInput.checked = !!this.config.idleLock;
        treeInput.value = String(Number(this.config.collapseTreeMinutes) || 0);
        contentEnableInput.checked = !!this.config.contentEnabled;
        contentTextInput.value = this.config.contentText || "";

        root.querySelector("#privacy-tree-pick").addEventListener("click", () => plugin.openContentPicker());
        root.querySelector("#privacy-tree-clear-btn").addEventListener("click", () => {
            plugin.doClear(true);
            const tbtn = root.querySelector("#privacy-tree-toggle-btn");
            const mstate = root.querySelector("#privacy-tree-mode-state");
            if (tbtn) {
                tbtn.textContent = plugin.t("btnOn", "开启隐私模式");
            }
            if (mstate) {
                mstate.textContent = plugin.t("statePrefix", "当前状态：") + plugin.t("stateOff", "已关闭");
            }
        });

        const toggleBtn = root.querySelector("#privacy-tree-toggle-btn");
        const modeState = root.querySelector("#privacy-tree-mode-state");
        toggleBtn.addEventListener("click", () => {
            plugin.forceLock = null;
            plugin.toggle();
            const on = plugin.active;
            toggleBtn.textContent = on ? plugin.t("btnOff", "关闭隐私模式") : plugin.t("btnOn", "开启隐私模式");
            modeState.textContent = plugin.t("statePrefix", "当前状态：") + (on ? plugin.t("stateOn", "已开启") : plugin.t("stateOff", "已关闭"));
        });

        const unamedInput = root.querySelector("#privacy-tree-unamed-input");
        const unamedToggle = root.querySelector(".privacy-tree-unamed-toggle");
        const curDocInput = root.querySelector("#privacy-tree-curdoc-input");
        const curDocToggle = root.querySelector("#privacy-tree-curdoc-toggle");

        root.querySelectorAll(".privacy-tree-alias-remove").forEach((btn) => {
            btn.addEventListener("click", async () => {
                const id = btn.getAttribute("data-id");
                delete plugin.config.aliases[id];
                await plugin.saveConfig();
                plugin.applyAliases();
                const chip = btn.closest("span");
                if (chip && chip.parentElement) {
                    chip.parentElement.removeChild(chip);
                }
            });
        });

        root.querySelector("#privacy-tree-cancel").addEventListener("click", () => {
            plugin.dialog = null;
            dialog.destroy();
        });
        root.querySelector("#privacy-tree-save").addEventListener("click", async () => {
            plugin.config.placeholder = placeholderInput.value;
            plugin.config.hotkey = hotkeyInput.value;
            plugin.config.showMessage = toastInput.checked;
            plugin.config.maskHeadings = headingsInput.checked;
            plugin.config.passwordEnabled = passwordEnableInput.checked;
            plugin.config.password = passwordInput.value;
            plugin.config.noEditLock = noEditInput.checked;
            plugin.config.idleMinutes = Math.max(0, Number(idleInput.value) || 0);
            plugin.config.idleLock = idleLockInput.checked;
            plugin.config.collapseTreeMinutes = Math.max(0, Number(treeInput.value) || 0);
            plugin.config.contentEnabled = contentEnableInput.checked;
            plugin.config.contentStyle = contentStyleInput.value;
            plugin.config.contentText = contentTextInput.value;

            const unamedText = unamedInput.value.trim();
            if (!unamedText) {
                delete plugin.config.aliases[UNNAMED_KEY];
            } else {
                plugin.config.aliases[UNNAMED_KEY] = { text: unamedText, title: UNNAMED_KEY, enabled: unamedToggle.checked };
            }

            if (doc.id && curDocInput) {
                const text = curDocInput.value.trim();
                if (!text) {
                    delete plugin.config.aliases[doc.id];
                } else {
                    plugin.config.aliases[doc.id] = { text: text, title: doc.title || doc.id, enabled: curDocToggle.checked };
                }
            }

            if (doc.id && curDocHideInput) {
                if (curDocHideInput.checked) {
                    plugin.config.hiddenItems[doc.id] = { enabled: true };
                } else {
                    delete plugin.config.hiddenItems[doc.id];
                }
            }

            const toggleMap = {};
            root.querySelectorAll(".privacy-tree-nb-toggle").forEach((t) => {
                toggleMap[t.getAttribute("data-id")] = t.checked;
            });
            root.querySelectorAll(".privacy-tree-nb-input").forEach((input) => {
                const id = input.getAttribute("data-id");
                const name = input.getAttribute("data-name");
                const text = input.value.trim();
                const enabled = toggleMap[id] !== false;
                if (!text) {
                    delete plugin.config.aliases[id];
                } else {
                    plugin.config.aliases[id] = { text: text, title: name || id, enabled: enabled };
                }
            });

            await plugin.saveConfig();
            plugin.applyAliases();
            if (plugin.active) {
                if (plugin.config.noEditLock) {
                    plugin.showBlockOverlay();
                } else {
                    plugin.hideBlockOverlay();
                }
                plugin.startTreeTimer();
            }
            plugin.resetIdle();
            showMessage(plugin.t("saved", "设置已保存"), 2000);
            plugin.dialog = null;
            dialog.destroy();
        });
    }
}

module.exports = PrivacyTreePlugin;
