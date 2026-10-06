"use strict";

const { Plugin, Dialog, showMessage } = require("siyuan");

const STORAGE_NAME = "config.json";
const ICON_ID = "iconPrivacyTree";
const ICON =
    '<symbol id="iconPrivacyTree" viewBox="0 0 32 32">' +
    '<path d="M4 3h24a2 2 0 0 1 2 2v22a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm3 8v3h18v-3H7zm0 6v2h12v-2H7zm0 5v2h8v-2H7z"></path>' +
    '<circle cx="22.5" cy="22.5" r="4.2" fill="none" stroke="currentColor" stroke-width="2.4"></circle>' +
    '<path d="M25.6 25.6l4.4 4.4" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"></path>' +
    "</symbol>";

const DEFAULT_CONFIG = {
    placeholder: "••••••",
    hotkey: "⌥⌘P",
    showMessage: true,
};

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
}

class PrivacyTreePlugin extends Plugin {
    constructor() {
        super(...arguments);
        this.config = Object.assign({}, DEFAULT_CONFIG);
        this.config.aliases = {};
        this.active = false;
        this.topBarEl = null;
        this.topBarAdded = false;
        this.dialog = null;
        this.observer = null;
        this.applyTimer = null;
        this.titleObserver = null;
        this.originalTitle = null;
    }

    async onload() {
        try {
            this.addIcons(ICON);
            await this.loadConfig();
            try {
                this.addCommand({
                    langKey: "togglePrivacyMode",
                    langText: "切换文档树隐私模式",
                    hotkey: this.config.hotkey,
                    callback: () => this.toggle(),
                });
            } catch (e) {
                console.error("[privacy-tree] 注册命令失败", e);
            }
            this.eventBus.on("open-menu-doctree", this.onDocTreeMenu);
        } catch (e) {
            console.error("[privacy-tree] onload error", e);
        }
        this.ensureTopBar();
    }

    onLayoutReady() {
        this.ensureTopBar();
    }

    onunload() {
        try {
            this.eventBus.off("open-menu-doctree", this.onDocTreeMenu);
        } catch (e) {
            /* ignore */
        }
        this.deactivate(false);
        this.active = false;
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
                callback: () => this.toggle(),
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
                click: () => this.toggle(),
            });
            const elements = detail.elements || [];
            if (elements.length === 1) {
                const el = elements[0];
                const id = this.resolveId(el);
                const textEl = el.querySelector(".b3-list-item__text");
                const title = this.realText(textEl);
                if (id) {
                    detail.menu.addItem({
                        id: "privacy-tree-alias",
                        icon: "iconEdit",
                        label: this.t("aliasSet", "设置隐私别名…"),
                        click: () => this.openAliasDialog(id, title),
                    });
                }
            }
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
            click: () => this.toggle(),
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
            if (saved && typeof saved === "object") {
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
    }

    async saveConfig() {
        try {
            await this.saveData(STORAGE_NAME, this.config);
        } catch (e) {
            console.error("[privacy-tree] 保存配置失败", e);
        }
    }

    // ---- 文本工具 ----

    textNodes(el) {
        const out = [];
        const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walker.nextNode())) {
            out.push(n);
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

    // 直接替换元素的文本节点为占位文本，保留子元素（图标等）
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

    // ---- 别名解析 ----

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

    // ---- 应用遮罩 ----

    applyAliases() {
        if (!this.active) {
            return;
        }
        // 左侧文档树
        document.querySelectorAll(".sy__file .b3-list-item").forEach((item) => {
            const textEl = item.querySelector(".b3-list-item__text");
            if (!textEl) {
                return;
            }
            const real = this.realText(textEl);
            const id = this.resolveId(item);
            this.maskText(textEl, this.mask(this.lookupAlias(id, real)));
        });
        // 顶部页签
        document.querySelectorAll(".layout-tab-bar .item .item__text").forEach((textEl) => {
            const tab = textEl.closest(".item");
            const real = this.realText(textEl);
            const id = tab ? this.tabBlockId(tab) : "";
            this.maskText(textEl, this.mask(this.lookupAlias(id, real)));
        });
        // 文档大标题
        document.querySelectorAll(".protyle-title").forEach((el) => {
            const real = this.realText(el);
            const id = el.getAttribute("data-node-id") || "";
            this.maskText(el, this.mask(this.lookupAlias(id, real)));
        });
        // 面包屑文字
        document.querySelectorAll(".protyle-breadcrumb__text").forEach((el) => {
            const holder = el.closest("[data-node-id]");
            const real = this.realText(el);
            const id = holder ? holder.getAttribute("data-node-id") : "";
            this.maskText(el, this.mask(this.lookupAlias(id, real)));
        });
        this.applyWindowTitle();
    }

    currentTabText() {
        const active = document.querySelector(".layout-tab-bar .item--focus .item__text");
        if (!active) {
            return this.config.placeholder || "";
        }
        const real = this.realText(active);
        const tab = active.closest(".item");
        const id = tab ? this.tabBlockId(tab) : "";
        return this.mask(this.lookupAlias(id, real));
    }

    applyWindowTitle() {
        if (!this.active) {
            return;
        }
        const masked = this.currentTabText();
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
        this.observer = new MutationObserver(() => this.scheduleApply());
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
            this.applyAliases();
        }, 150);
    }

    activate() {
        document.documentElement.classList.add("privacy-tree-on");
        this.active = true;
        this.updateButton();
        this.applyAliases();
        this.startObserver();
        this.startTitleGuard();
        if (this.config.showMessage) {
            showMessage(this.t("on", "已开启文档树隐私模式"), 2000);
        }
    }

    deactivate(notify) {
        document.documentElement.classList.remove("privacy-tree-on");
        const wasActive = this.active;
        this.active = false;
        this.updateButton();
        this.stopObserver();
        this.stopTitleGuard();
        document.querySelectorAll("[data-privacy-on]").forEach((el) => this.unmaskText(el));
        if (notify !== false && wasActive && this.config.showMessage) {
            showMessage(this.t("off", "已关闭文档树隐私模式"), 2000);
        }
    }

    toggle() {
        if (this.active) {
            this.deactivate();
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

    // ---- 对话框 ----

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
                '<div style="padding:8px 4px;">' +
                '<div class="b3-label__text" style="margin-bottom:8px;">' + escapeHtml(title || id) + "</div>" +
                '<input id="privacy-tree-alias-input" class="b3-text-field fn__block" />' +
                '<div class="b3-label" style="margin-top:8px;"><label class="fn__flex" style="align-items:center;">' +
                '<input id="privacy-tree-alias-enabled" type="checkbox" class="b3-switch" style="margin-right:8px;" />' +
                "<span>" + this.t("aliasEnable", "启用单独别名") + "</span></label></div>" +
                '<div class="b3-dialog__action" style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px;">' +
                '<button id="privacy-tree-alias-clear" class="b3-button b3-button--cancel">' + this.t("aliasClear", "清除别名") + "</button>" +
                '<button id="privacy-tree-alias-save" class="b3-button b3-button--text">' + this.t("save", "保存") + "</button>" +
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

    openSettings() {
        const plugin = this;
        if (this.dialog) {
            this.dialog.destroy();
            this.dialog = null;
        }

        const entries = Object.entries(this.config.aliases);
        let aliasHtml;
        if (entries.length === 0) {
            aliasHtml = '<div class="b3-label__text">' + this.t("aliasNone", "暂无别名") + "</div>";
        } else {
            aliasHtml = entries
                .map(([id, alias]) => {
                    const title = (alias && alias.title) || id;
                    const text = (alias && alias.text) || "";
                    const off = alias && alias.enabled === false ? this.t("aliasOff", "（已关闭）") : "";
                    return (
                        '<span style="display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border-radius:12px;background:var(--b3-theme-surface);margin:2px;">' +
                        '<span title="' + escapeHtml(id) + '">' + escapeHtml(title) + " → " + escapeHtml(text) + escapeHtml(off) + "</span>" +
                        '<span class="privacy-tree-alias-remove" data-id="' + escapeHtml(id) + '" style="cursor:pointer;opacity:.6;">✕</span>' +
                        "</span>"
                    );
                })
                .join("");
        }

        const notebooks = (window.siyuan && window.siyuan.notebooks) || [];
        let nbHtml;
        if (notebooks.length === 0) {
            nbHtml = '<div class="b3-label__text">' + this.t("nbNone", "未检测到笔记本") + "</div>";
        } else {
            nbHtml = notebooks
                .map((nb) => {
                    return (
                        '<div class="fn__flex" style="align-items:center;gap:8px;margin:4px 0;">' +
                        '<span class="fn__flex-1" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
                        escapeHtml(nb.name) +
                        "</span>" +
                        '<input type="checkbox" class="b3-switch privacy-tree-nb-toggle" data-id="' + escapeHtml(nb.id) + '" title="' + this.t("aliasEnable", "启用单独别名") + '" />' +
                        '<input class="b3-text-field privacy-tree-nb-input" data-id="' + escapeHtml(nb.id) + '" data-name="' + escapeHtml(nb.name) + '" style="width:170px;" />' +
                        "</div>"
                    );
                })
                .join("");
        }

        const dialog = new Dialog({
            title: this.t("settingsTitle", "文档树隐私保护设置"),
            width: "620px",
            content:
                '<div style="padding:8px 4px;max-height:60vh;overflow:auto;">' +
                '<div class="b3-label">' + this.t("placeholderLabel", "默认占位内容") +
                '<div class="b3-label__text">' + this.t("placeholderDesc", "没有启用别名的条目都用它替代") + "</div></div>" +
                '<input id="privacy-tree-placeholder" class="b3-text-field fn__block" />' +
                '<div class="b3-label" style="margin-top:12px;">' + this.t("nbLabel", "笔记本（项目）别名") +
                '<div class="b3-label__text">' + this.t("nbDesc", "左侧开关＝是否启用单独设置；右边填显示名称") + "</div></div>" +
                '<div id="privacy-tree-nb-list">' + nbHtml + "</div>" +
                '<div class="b3-label" style="margin-top:12px;">' + this.t("aliasLabel", "文档别名") +
                '<div class="b3-label__text">' + this.t("aliasDesc", "在文档树中右键某个文档即可设置；遮盖范围含左侧文档树、顶部页签、文档大标题、窗口标题") + "</div></div>" +
                '<div id="privacy-tree-alias-list">' + aliasHtml + "</div>" +
                '<div class="b3-label" style="margin-top:12px;">' + this.t("hotkeyLabel", "快捷键") +
                '<div class="b3-label__text">' + this.t("hotkeyDesc", "建议在「设置 → 快捷键」中按下组合键") + "</div></div>" +
                '<input id="privacy-tree-hotkey" class="b3-text-field fn__block" />' +
                '<div class="b3-label" style="margin-top:12px;"><label class="fn__flex">' +
                '<input id="privacy-tree-toast" type="checkbox" class="b3-switch" style="margin-right:8px;" />' +
                "<span>" + this.t("toastLabel", "切换时显示提示") + "</span></label></div>" +
                '<div class="b3-dialog__action" style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px;">' +
                '<button id="privacy-tree-cancel" class="b3-button b3-button--cancel">' + this.t("cancel", "取消") + "</button>" +
                '<button id="privacy-tree-save" class="b3-button b3-button--text">' + this.t("save", "保存") + "</button>" +
                "</div></div>",
        });
        this.dialog = dialog;
        const root = dialog.element;
        const placeholderInput = root.querySelector("#privacy-tree-placeholder");
        const hotkeyInput = root.querySelector("#privacy-tree-hotkey");
        const toastInput = root.querySelector("#privacy-tree-toast");
        placeholderInput.value = this.config.placeholder;
        hotkeyInput.value = this.config.hotkey;
        toastInput.checked = !!this.config.showMessage;

        root.querySelectorAll(".privacy-tree-nb-input").forEach((input) => {
            const id = input.getAttribute("data-id");
            const alias = plugin.config.aliases[id];
            input.value = (alias && alias.text) || "";
            input.placeholder = plugin.config.placeholder || "";
        });
        root.querySelectorAll(".privacy-tree-nb-toggle").forEach((toggle) => {
            const id = toggle.getAttribute("data-id");
            const alias = plugin.config.aliases[id];
            toggle.checked = !!(alias && alias.enabled !== false);
        });

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
            showMessage(plugin.t("saved", "设置已保存"), 2000);
            plugin.dialog = null;
            dialog.destroy();
        });
    }
}

module.exports = PrivacyTreePlugin;
