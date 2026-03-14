const DB_PATH = "/usr/local/share/cockpit/dashboard/db.json";
const REFRESH_OPTIONS = [0, 5, 10, 15];
const DEFAULT_REFRESH_SECONDS = 10;
const dbFile = cockpit.file(DB_PATH, { syntax: JSON, superuser: "try" });

const state = {
    db: { services: [], commands: [], settings: { autoRefreshSeconds: DEFAULT_REFRESH_SECONDS } },
    availableServices: [],
    selectedService: null,
    editingServiceIndex: null,
    editingCommandId: null,
    deleteTarget: null,
    draggedServiceId: null,
    refreshTimer: null,
    refreshToken: 0,
    isRefreshing: false,
    lastRefreshAt: null,
    serviceStatus: {},
    commandRunState: {},
};

const elements = {
    addService: document.getElementById("add-service"),
    addScript: document.getElementById("add-script"),
    refreshButton: document.getElementById("refresh-statuses"),
    refreshInterval: document.getElementById("refresh-interval"),
    refreshMeta: document.getElementById("refresh-meta"),
    notification: document.getElementById("notification"),
    services: document.getElementById("services"),
    commands: document.getElementById("commands"),
    serviceCardTemplate: document.getElementById("service-card-template"),
    commandCardTemplate: document.getElementById("command-card-template"),
    serviceModal: document.getElementById("service-modal"),
    serviceModalTitle: document.getElementById("service-modal-title"),
    serviceSearch: document.getElementById("service-search"),
    servicePickerStatus: document.getElementById("service-picker-status"),
    servicePicker: document.getElementById("service-picker"),
    serviceTitleInput: document.getElementById("service-title-input"),
    serviceSave: document.getElementById("service-save"),
    scriptModal: document.getElementById("script-modal"),
    scriptModalTitle: document.getElementById("script-modal-title"),
    scriptTitleInput: document.getElementById("script-title-input"),
    scriptCommandInput: document.getElementById("script-command-input"),
    scriptSave: document.getElementById("script-save"),
    confirmModal: document.getElementById("confirm-modal"),
    confirmModalText: document.getElementById("confirm-modal-text"),
    confirmDelete: document.getElementById("confirm-delete"),
};

function createId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeRefreshSeconds(value) {
    const parsed = Number(value);
    return REFRESH_OPTIONS.includes(parsed) ? parsed : DEFAULT_REFRESH_SECONDS;
}

function ensureDBShape(content) {
    const db = content || {};

    db.services = Array.isArray(db.services)
        ? db.services
            .filter((service) => service && typeof service.name === "string" && service.name.trim())
            .map((service) => ({
                id: service.id || createId("svc"),
                name: service.name.trim(),
                title: service.title && service.title.trim() ? service.title.trim() : service.name.trim(),
            }))
        : [];

    db.commands = Array.isArray(db.commands)
        ? db.commands
            .filter((command) => command && typeof command.command === "string" && command.command.trim())
            .map((command) => ({
                id: command.id || createId("cmd"),
                title: command.title && command.title.trim() ? command.title.trim() : "Quick script",
                command: command.command.trim(),
            }))
        : [];

    db.settings = db.settings || {};
    db.settings.autoRefreshSeconds = normalizeRefreshSeconds(db.settings.autoRefreshSeconds);

    return db;
}

function showNotification(message, isError = false) {
    elements.notification.textContent = message;
    elements.notification.classList.remove("hidden", "error");
    if (isError) {
        elements.notification.classList.add("error");
    }
}

function clearNotification() {
    elements.notification.classList.add("hidden");
    elements.notification.classList.remove("error");
    elements.notification.textContent = "";
}

function getServiceTitle(service) {
    return service.title && service.title.trim() ? service.title.trim() : service.name;
}

function getCommandTitle(command) {
    return command.title && command.title.trim() ? command.title.trim() : "Quick script";
}

function saveDB(mutator) {
    return dbFile.modify((current) => {
        const next = ensureDBShape(current);
        mutator(next);
        return ensureDBShape(next);
    }).then(() => loadDB({ preserveNotification: true }));
}

function parseServiceList(output) {
    return output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const parts = line.split(/\s+/);
            return {
                name: parts[0],
                state: parts[1] || "unknown",
                preset: parts[2] || "unknown",
            };
        })
        .filter((service) => service.name.endsWith(".service"))
        .sort((left, right) => left.name.localeCompare(right.name));
}

function loadAvailableServices() {
    elements.servicePickerStatus.textContent = "Loading services...";
    return cockpit.spawn([
        "systemctl",
        "list-unit-files",
        "--type=service",
        "--all",
        "--no-legend",
        "--no-pager",
    ], { err: "message" })
        .then((output) => {
            state.availableServices = parseServiceList(output);
            renderServicePicker();
        })
        .catch((error) => {
            state.availableServices = [];
            renderServicePicker();
            showNotification(`Unable to load systemd services: ${cockpit.message(error)}`, true);
        });
}

function getFilteredServices() {
    const query = elements.serviceSearch.value.trim().toLowerCase();
    return state.availableServices.filter((service) => {
        if (!query) {
            return true;
        }
        return service.name.toLowerCase().includes(query);
    });
}

function renderServicePicker() {
    const filtered = getFilteredServices();
    elements.servicePicker.innerHTML = "";

    if (!state.availableServices.length) {
        elements.servicePickerStatus.textContent = state.editingServiceIndex === null
            ? "No services available."
            : "Service list unavailable, but the card title can still be changed.";
        elements.serviceSave.disabled = state.editingServiceIndex === null;
        return;
    }

    if (!filtered.length) {
        elements.servicePickerStatus.textContent = "No services match the current search.";
        elements.serviceSave.disabled = state.editingServiceIndex === null;
        return;
    }

    elements.servicePickerStatus.textContent = `${filtered.length} service${filtered.length === 1 ? "" : "s"} found`;

    filtered.forEach((service) => {
        const option = document.createElement("button");
        const name = document.createElement("strong");
        const meta = document.createElement("span");

        option.type = "button";
        option.className = "service-option";
        option.setAttribute("role", "option");

        if (state.selectedService === service.name) {
            option.classList.add("selected");
            option.setAttribute("aria-selected", "true");
        }

        name.textContent = service.name;
        meta.textContent = `Unit file: ${service.state} | Preset: ${service.preset}`;
        option.appendChild(name);
        option.appendChild(meta);

        option.addEventListener("click", () => {
            state.selectedService = service.name;
            if (!elements.serviceTitleInput.value.trim() || state.editingServiceIndex === null) {
                elements.serviceTitleInput.value = service.name.replace(/\.service$/, "");
            }
            renderServicePicker();
        });

        elements.servicePicker.appendChild(option);
    });

    elements.serviceSave.disabled = state.editingServiceIndex === null ? !state.selectedService : false;
}

function openServiceModal(editIndex = null) {
    state.editingServiceIndex = editIndex;
    elements.serviceSearch.value = "";
    elements.servicePicker.innerHTML = "";
    elements.servicePickerStatus.textContent = "Loading services...";

    if (editIndex === null) {
        state.selectedService = null;
        elements.serviceModalTitle.textContent = "Add service";
        elements.serviceTitleInput.value = "";
        elements.serviceSave.textContent = "Add service";
        elements.serviceSave.disabled = true;
    } else {
        const service = state.db.services[editIndex];
        state.selectedService = service.name;
        elements.serviceModalTitle.textContent = "Rename service card";
        elements.serviceTitleInput.value = getServiceTitle(service);
        elements.serviceSave.textContent = "Save title";
        elements.serviceSave.disabled = false;
    }

    elements.serviceModal.classList.remove("hidden");
    renderServicePicker();
    loadAvailableServices();
    elements.serviceSearch.focus();
}

function closeServiceModal() {
    elements.serviceModal.classList.add("hidden");
    state.selectedService = null;
    state.editingServiceIndex = null;
}

function openScriptModal(commandId = null) {
    state.editingCommandId = commandId;

    if (commandId === null) {
        elements.scriptModalTitle.textContent = "Add quick script";
        elements.scriptTitleInput.value = "";
        elements.scriptCommandInput.value = "";
        elements.scriptSave.textContent = "Save script";
    } else {
        const command = state.db.commands.find((item) => item.id === commandId);
        elements.scriptModalTitle.textContent = "Edit quick script";
        elements.scriptTitleInput.value = getCommandTitle(command);
        elements.scriptCommandInput.value = command.command;
        elements.scriptSave.textContent = "Save changes";
    }

    elements.scriptModal.classList.remove("hidden");
    elements.scriptTitleInput.focus();
}

function closeScriptModal() {
    elements.scriptModal.classList.add("hidden");
    state.editingCommandId = null;
}

function openDeleteModal(target) {
    state.deleteTarget = target;
    if (target.type === "service") {
        elements.confirmModalText.textContent = `Delete the card for ${target.label}? The systemd service itself will not be removed.`;
    } else {
        elements.confirmModalText.textContent = `Delete the quick script ${target.label}? This only removes it from the dashboard.`;
    }
    elements.confirmModal.classList.remove("hidden");
}

function closeDeleteModal() {
    elements.confirmModal.classList.add("hidden");
    state.deleteTarget = null;
}

function formatStatus(activeState, subState) {
    if (activeState === "active") {
        return {
            label: "Running",
            detail: `Active (${subState || "running"})`,
            className: "running",
        };
    }

    if (activeState === "failed") {
        return {
            label: "Failed",
            detail: `Failed (${subState || "error"})`,
            className: "failed",
        };
    }

    if (activeState === "activating") {
        return {
            label: "Starting",
            detail: `Activating (${subState || "start"})`,
            className: "refreshing",
        };
    }

    return {
        label: "Stopped",
        detail: `${activeState || "inactive"} (${subState || "dead"})`,
        className: "stopped",
    };
}

function fetchServiceStatus(serviceName) {
    return cockpit.spawn([
        "systemctl",
        "show",
        serviceName,
        "--property=ActiveState",
        "--property=SubState",
        "--property=UnitFileState",
        "--no-pager",
    ], { err: "message" })
        .then((output) => {
            const details = {};
            output.trim().split("\n").forEach((line) => {
                const [key, ...valueParts] = line.split("=");
                details[key] = valueParts.join("=");
            });
            return details;
        })
        .catch(() => ({ ActiveState: "unknown", SubState: "unknown", UnitFileState: "unknown" }));
}

function formatRefreshTime(date) {
    if (!date) {
        return "Statuses have not been refreshed yet.";
    }
    return `Last status refresh: ${date.toLocaleTimeString()}`;
}

function updateRefreshMeta() {
    const autoRefreshSeconds = state.db.settings.autoRefreshSeconds;
    const suffix = autoRefreshSeconds > 0 ? ` Auto refresh every ${autoRefreshSeconds} sec.` : " Auto refresh is off.";
    if (elements.refreshMeta) {
        elements.refreshMeta.textContent = `${formatRefreshTime(state.lastRefreshAt)}${suffix}`;
    }
}

function syncRefreshControls() {
    if (elements.refreshInterval) {
        elements.refreshInterval.value = String(state.db.settings.autoRefreshSeconds);
    }
    if (elements.refreshButton) {
        elements.refreshButton.disabled = state.isRefreshing;
    }
    updateRefreshMeta();
}

function scheduleAutoRefresh() {
    if (state.refreshTimer) {
        window.clearInterval(state.refreshTimer);
        state.refreshTimer = null;
    }

    const seconds = state.db.settings.autoRefreshSeconds;
    if (seconds > 0) {
        state.refreshTimer = window.setInterval(() => {
            refreshServiceStatuses(false);
        }, seconds * 1000);
    }
}

function setRefreshingState(isRefreshing) {
    state.isRefreshing = isRefreshing;
    syncRefreshControls();
}

function updateServiceCardStatus(serviceId, details) {
    const service = state.db.services.find((item) => item.id === serviceId);
    const card = elements.services.querySelector(`[data-service-id="${serviceId}"]`);
    if (!card || !service) {
        return;
    }

    const badge = card.querySelector(".status-badge");
    const startButton = card.querySelector(".action-start");
    const stopButton = card.querySelector(".action-stop");
    const formatted = formatStatus(details.ActiveState, details.SubState);

    badge.textContent = formatted.label;
    badge.className = `status-badge ${formatted.className}`;
    startButton.disabled = details.ActiveState === "active" || state.isRefreshing && details.ActiveState === "activating";
    stopButton.disabled = details.ActiveState !== "active";
}

function refreshServiceStatuses(showToast = false) {
    const services = state.db.services.slice();
    const token = ++state.refreshToken;

    if (!services.length) {
        state.lastRefreshAt = new Date();
        syncRefreshControls();
        return Promise.resolve();
    }

    setRefreshingState(true);

    const refreshWork = services.map((service) => {
        return fetchServiceStatus(service.name).then((details) => ({ service, details }));
    });

    return Promise.allSettled(refreshWork)
        .then((results) => {
            if (token !== state.refreshToken) {
                return;
            }

            results.forEach((result) => {
                if (result.status !== "fulfilled") {
                    return;
                }
                const { service, details } = result.value;
                state.serviceStatus[service.id] = details;
                updateServiceCardStatus(service.id, details);
            });

            state.lastRefreshAt = new Date();
            if (showToast) {
                showNotification("Service statuses refreshed.");
            }
        })
        .finally(() => {
            if (token === state.refreshToken) {
                setRefreshingState(false);
            }
        });
}

function renderEmptyState(container, text) {
    container.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = text;
    container.appendChild(empty);
}

function moveService(fromIndex, toIndex) {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) {
        return Promise.resolve();
    }

    return saveDB((db) => {
        const [moved] = db.services.splice(fromIndex, 1);
        db.services.splice(toIndex, 0, moved);
    }).then(() => {
        showNotification("Service order updated.");
    }).catch((error) => {
        showNotification(`Unable to reorder services: ${cockpit.message(error)}`, true);
    });
}

function renderServices() {
    const services = state.db.services;
    elements.services.innerHTML = "";

    if (!services.length) {
        renderEmptyState(elements.services, 'No services added yet. Use <strong>Add service</strong> to create your first card.');
        return;
    }

    services.forEach((service, index) => {
        const fragment = elements.serviceCardTemplate.content.cloneNode(true);
        const card = fragment.querySelector(".service-card");
        const title = fragment.querySelector(".service-title");
        const name = fragment.querySelector(".service-name");
        const startButton = fragment.querySelector(".action-start");
        const stopButton = fragment.querySelector(".action-stop");
        const renameButton = fragment.querySelector(".action-title");
        const deleteButton = fragment.querySelector(".action-delete");

        card.dataset.serviceId = service.id;
        card.dataset.serviceIndex = String(index);
        {
            const rowStart = Math.floor(index / 2) * 2;
            const itemsInRow = Math.min(2, services.length - rowStart);
            card.style.gridColumn = `span ${itemsInRow === 1 ? 12 : 6}`;
        }
        title.textContent = getServiceTitle(service);
        name.textContent = service.name;

        startButton.addEventListener("click", () => runServiceAction(service.name, "start"));
        stopButton.addEventListener("click", () => runServiceAction(service.name, "stop"));
        renameButton.addEventListener("click", () => openServiceModal(index));
        deleteButton.addEventListener("click", () => {
            openDeleteModal({ type: "service", id: service.id, label: getServiceTitle(service) });
        });

        card.addEventListener("dragstart", (event) => {
            state.draggedServiceId = service.id;
            card.classList.add("dragging");
            if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", service.id);
            }
        });

        card.addEventListener("dragend", () => {
            state.draggedServiceId = null;
            elements.services.querySelectorAll(".service-card").forEach((item) => {
                item.classList.remove("dragging", "drag-over");
            });
        });

        card.addEventListener("dragover", (event) => {
            event.preventDefault();
            if (state.draggedServiceId && state.draggedServiceId !== service.id) {
                card.classList.add("drag-over");
            }
        });

        card.addEventListener("dragleave", () => {
            card.classList.remove("drag-over");
        });

        card.addEventListener("drop", (event) => {
            event.preventDefault();
            card.classList.remove("drag-over");
            const fromIndex = state.db.services.findIndex((item) => item.id === state.draggedServiceId);
            const toIndex = state.db.services.findIndex((item) => item.id === service.id);
            moveService(fromIndex, toIndex);
        });

        elements.services.appendChild(fragment);
    });
}

function renderCommands() {
    const commands = state.db.commands;
    elements.commands.innerHTML = "";

    if (!commands.length) {
        renderEmptyState(elements.commands, 'No quick scripts yet. Use <strong>Add quick script</strong> to save reusable server commands.');
        return;
    }

    commands.forEach((command, index) => {
        const fragment = elements.commandCardTemplate.content.cloneNode(true);
        const card = fragment.querySelector(".command-card");
        const title = fragment.querySelector(".command-title");
        const status = fragment.querySelector(".command-status");
        const runButton = fragment.querySelector(".action-run-script");
        const editButton = fragment.querySelector(".action-edit-script");
        const deleteButton = fragment.querySelector(".action-delete-script");
        const runState = state.commandRunState[command.id];

        card.dataset.commandId = command.id;
        {
            const rowStart = Math.floor(index / 3) * 3;
            const itemsInRow = Math.min(3, commands.length - rowStart);
            const span = itemsInRow === 1 ? 12 : itemsInRow === 2 ? 6 : 4;
            card.style.gridColumn = `span ${span}`;
        }
        title.textContent = getCommandTitle(command);
        if (status) {
            status.textContent = runState ? runState.message : "Ready to run.";
        }

        runButton.disabled = !!(runState && runState.running);
        runButton.textContent = runState && runState.running ? "Running..." : "Run";

        runButton.addEventListener("click", () => runQuickScript(command));
        editButton.addEventListener("click", () => openScriptModal(command.id));
        deleteButton.addEventListener("click", () => {
            openDeleteModal({ type: "command", id: command.id, label: getCommandTitle(command) });
        });

        elements.commands.appendChild(fragment);
    });
}

function loadDB(options = {}) {
    if (!options.preserveNotification) {
        clearNotification();
    }

    return dbFile.read()
        .then((content) => {
            state.db = ensureDBShape(content);
            renderServices();
            renderCommands();
            syncRefreshControls();
            scheduleAutoRefresh();
            return refreshServiceStatuses(false);
        })
        .catch((error) => {
            showNotification(`Unable to read ${DB_PATH}: ${cockpit.message(error)}`, true);
            state.db = ensureDBShape(null);
            renderServices();
            renderCommands();
            syncRefreshControls();
        });
}

function runServiceAction(serviceName, action) {
    clearNotification();
    cockpit.spawn(["systemctl", action, serviceName], {
        superuser: "try",
        err: "message",
    })
        .then(() => {
            showNotification(`Service ${serviceName} ${action}ed successfully.`);
            refreshServiceStatuses(false);
        })
        .catch((error) => {
            showNotification(`Unable to ${action} ${serviceName}: ${cockpit.message(error)}`, true);
        });
}

function addOrUpdateService() {
    const selectedService = state.selectedService ? state.selectedService.trim() : "";
    const title = elements.serviceTitleInput.value.trim();

    if (state.editingServiceIndex !== null) {
        saveDB((db) => {
            db.services[state.editingServiceIndex].title = title || db.services[state.editingServiceIndex].name;
        })
            .then(() => {
                closeServiceModal();
                showNotification(`Updated card title for ${selectedService}.`);
            })
            .catch((error) => {
                showNotification(`Unable to save title: ${cockpit.message(error)}`, true);
            });
        return;
    }

    if (!selectedService) {
        showNotification("Select a systemd service first.", true);
        return;
    }

    if (state.db.services.some((service) => service.name === selectedService)) {
        showNotification(`Service ${selectedService} is already on the dashboard.`, true);
        return;
    }

    saveDB((db) => {
        db.services.push({
            id: createId("svc"),
            name: selectedService,
            title: title || selectedService.replace(/\.service$/, ""),
        });
    })
        .then(() => {
            closeServiceModal();
            showNotification(`Added ${selectedService} to the dashboard.`);
        })
        .catch((error) => {
            showNotification(`Unable to save service: ${cockpit.message(error)}`, true);
        });
}

function saveScript() {
    const title = elements.scriptTitleInput.value.trim();
    const commandText = elements.scriptCommandInput.value.trim();

    if (!commandText) {
        showNotification("Enter a command for the quick script.", true);
        return;
    }

    if (state.editingCommandId) {
        saveDB((db) => {
            const command = db.commands.find((item) => item.id === state.editingCommandId);
            command.title = title || command.title;
            command.command = commandText;
        })
            .then(() => {
                closeScriptModal();
                showNotification(`Updated quick script ${title || "script"}.`);
            })
            .catch((error) => {
                showNotification(`Unable to save quick script: ${cockpit.message(error)}`, true);
            });
        return;
    }

    saveDB((db) => {
        db.commands.push({
            id: createId("cmd"),
            title: title || "Quick script",
            command: commandText,
        });
    })
        .then(() => {
            closeScriptModal();
            showNotification(`Added quick script ${title || "script"}.`);
        })
        .catch((error) => {
            showNotification(`Unable to save quick script: ${cockpit.message(error)}`, true);
        });
}

function runQuickScript(command) {
    state.commandRunState[command.id] = {
        running: true,
        message: `Running: ${command.command}`,
    };
    renderCommands();

    cockpit.spawn(["bash", "-lc", command.command], {
        superuser: "try",
        err: "message",
    })
        .then((output) => {
            const trimmedOutput = output && output.trim() ? ` Output: ${output.trim().slice(0, 220)}` : "";
            state.commandRunState[command.id] = {
                running: false,
                message: `Completed successfully.${trimmedOutput}`,
            };
            renderCommands();
            showNotification(`Quick script ${getCommandTitle(command)} finished successfully.`);
        })
        .catch((error) => {
            state.commandRunState[command.id] = {
                running: false,
                message: `Failed: ${cockpit.message(error)}`,
            };
            renderCommands();
            showNotification(`Quick script ${getCommandTitle(command)} failed: ${cockpit.message(error)}`, true);
        });
}

function deleteSelectedItem() {
    const target = state.deleteTarget;
    if (!target) {
        return;
    }

    const operation = target.type === "service"
        ? saveDB((db) => {
            db.services = db.services.filter((service) => service.id !== target.id);
        })
        : saveDB((db) => {
            db.commands = db.commands.filter((command) => command.id !== target.id);
        });

    operation
        .then(() => {
            closeDeleteModal();
            showNotification(`Deleted ${target.label}.`);
        })
        .catch((error) => {
            showNotification(`Unable to delete ${target.label}: ${cockpit.message(error)}`, true);
        });
}

function updateAutoRefresh(value) {
    const seconds = normalizeRefreshSeconds(value);
    saveDB((db) => {
        db.settings.autoRefreshSeconds = seconds;
    })
        .then(() => {
            showNotification(seconds > 0 ? `Auto refresh set to ${seconds} seconds.` : "Auto refresh disabled.");
        })
        .catch((error) => {
            showNotification(`Unable to update auto refresh: ${cockpit.message(error)}`, true);
        });
}

function handleModalClose(event) {
    const modalName = event.target.getAttribute("data-close-modal");
    if (modalName === "service") {
        closeServiceModal();
    }
    if (modalName === "script") {
        closeScriptModal();
    }
    if (modalName === "confirm") {
        closeDeleteModal();
    }
}

function parseThemeToken(value) {
    const text = String(value || "").toLowerCase();
    if (!text) {
        return null;
    }
    if (text.includes("light")) {
        return "light";
    }
    if (text.includes("dark")) {
        return "dark";
    }
    return null;
}

function readThemeFromNode(node) {
    if (!node) {
        return null;
    }

    const attrs = ["data-theme", "data-pf-theme", "theme"];
    for (const attr of attrs) {
        const theme = parseThemeToken(node.getAttribute && node.getAttribute(attr));
        if (theme) {
            return theme;
        }
    }

    if (node.classList) {
        const theme = parseThemeToken(node.className);
        if (theme) {
            return theme;
        }
    }

    return null;
}

function readThemeFromStorage(win) {
    try {
        const raw = win.localStorage && win.localStorage.getItem("shell:style");
        if (raw === "auto" || raw === "default") {
            return "auto";
        }
        return parseThemeToken(raw);
    } catch (_) {
        return null;
    }
}

function resolveDashboardTheme() {
    try {
        if (window.parent && window.parent !== window) {
            const parentTheme = readThemeFromStorage(window.parent);
            if (parentTheme === "light" || parentTheme === "dark") {
                return parentTheme;
            }
            if (parentTheme === "auto") {
                return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
            }

            const parentDoc = window.parent.document;
            const explicitTheme = readThemeFromNode(parentDoc.documentElement) || readThemeFromNode(parentDoc.body);
            if (explicitTheme) {
                return explicitTheme;
            }
        }
    } catch (_) {
        // Ignore cross-frame access problems and fall back below.
    }

    const localTheme = readThemeFromStorage(window);
    if (localTheme === "light" || localTheme === "dark") {
        return localTheme;
    }
    if (localTheme === "auto") {
        return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    }

    const themeFromDocument = readThemeFromNode(document.documentElement) || readThemeFromNode(document.body);
    if (themeFromDocument) {
        return themeFromDocument;
    }

    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme(theme) {
    document.documentElement.setAttribute("data-dashboard-theme", theme === "light" ? "light" : "dark");
}

function installThemeSync() {
    const syncTheme = () => applyTheme(resolveDashboardTheme());
    syncTheme();

    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "data-pf-theme", "theme"] });

    try {
        if (window.parent && window.parent !== window) {
            observer.observe(window.parent.document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "data-pf-theme", "theme"] });
        }
    } catch (_) {
        // Ignore if parent document is not observable.
    }

    window.addEventListener("storage", syncTheme);
    const media = window.matchMedia("(prefers-color-scheme: light)");
    if (media.addEventListener) {
        media.addEventListener("change", syncTheme);
    } else if (media.addListener) {
        media.addListener(syncTheme);
    }
}

Array.from(document.querySelectorAll("[data-close-modal]")).forEach((button) => {
    button.addEventListener("click", handleModalClose);
});

elements.addService.addEventListener("click", () => {
    clearNotification();
    openServiceModal();
});

elements.addScript.addEventListener("click", () => {
    clearNotification();
    openScriptModal();
});

elements.refreshButton.addEventListener("click", () => {
    clearNotification();
    refreshServiceStatuses(true);
});

elements.refreshInterval.addEventListener("change", (event) => {
    clearNotification();
    updateAutoRefresh(event.target.value);
});

elements.serviceSearch.addEventListener("input", renderServicePicker);

elements.serviceSave.addEventListener("click", addOrUpdateService);

elements.scriptSave.addEventListener("click", saveScript);

elements.confirmDelete.addEventListener("click", deleteSelectedItem);

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        closeServiceModal();
        closeScriptModal();
        closeDeleteModal();
    }
});

installThemeSync();
loadDB();
