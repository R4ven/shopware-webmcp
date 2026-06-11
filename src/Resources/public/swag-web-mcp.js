/**
 * Shopware Storefront WebMCP Bootstrap (schema-getrieben)
 * =======================================================
 * Generiert MCP-Tools fuer Browser-Agenten automatisch aus dem Live-Schema der
 * Store-API (GET /store-api/_info/openapi3.json) und stellt sie ueber die
 * WebMCP-API (navigator.modelContext) bereit. Dadurch sind alle Routen, die der
 * Shop tatsaechlich anbietet – inkl. installierter Plugins wie B2B Commerce –
 * ohne hartkodierte Pfadlisten verfuegbar.
 *
 * Welche Operationen als Tools erscheinen, steuert die Admin-Konfiguration
 * (pro Sales-Channel), durchgereicht ueber window.swagWebMcpConfig:
 *   - schemaDriven      Schalter fuer die Schema-Generierung (Default an)
 *   - allowlist         nur passende Operationen anbieten (leer = alle)
 *   - denylist          passende Operationen ausschliessen
 *   - includeMutations  PUT/PATCH/DELETE zulassen (Default aus)
 *   - maxTools          Obergrenze fuer die Tool-Anzahl
 *
 * ERWEITERBARKEIT
 * ---------------
 * Andere Plugins koennen zusaetzlich eigene, handkuratierte Tools beisteuern –
 * ladereihenfolge-unabhaengig ueber eine Command-Queue:
 *
 *     (window.SwagWebMcp = window.SwagWebMcp || []).push(function (mcp) {
 *         mcp.registerTool({
 *             name: 'my_tool',
 *             description: '...',
 *             inputSchema: { type: 'object', properties: { ... } },
 *             isAvailable: function () { return true; },          // optionales Gate
 *             run: function (args) { return mcp.storeApi('POST', '/...', args); }
 *         });
 *     });
 *
 * mcp stellt bereit: registerTool, unregisterTool, getTools, callTool, refresh,
 * storeApi(method, path, body), config.
 *
 * Faellt der Browser/Agent ohne native WebMCP-Unterstuetzung auf, wird ein
 * leichtes Polyfill installiert, das die Tools unter navigator.modelContext und
 * window.SwagWebMcp auffindbar macht.
 */
(function () {
    'use strict';

    var config = window.swagWebMcpConfig || {};

    if (!config.storeApiUrl || !config.accessKey) {
        console.warn('[WebMCP] Fehlende Konfiguration (storeApiUrl/accessKey) – Tools werden nicht registriert.');
        return;
    }

    // --- Konfiguration mit Defaults (null/undefined faellt auf Default zurueck) ---
    var DEFAULT_DENY = ['*login*', '*logout*', '*register*', '*password*', '*recovery*', '*newsletter*'];

    function parseList(value) {
        if (value === null || value === undefined) {
            return [];
        }
        return String(value).split(/[\n,]+/).map(function (entry) {
            return entry.trim();
        }).filter(Boolean);
    }

    var schemaDriven = config.schemaDriven !== false; // Default: an
    var includeMutations = config.includeMutations === true; // Default: aus
    var maxTools = (typeof config.maxTools === 'number' && config.maxTools > 0) ? config.maxTools : 100;
    var allowlist = parseList(config.allowlist);
    var denylist = (config.denylist !== null && config.denylist !== undefined && String(config.denylist).trim() !== '')
        ? parseList(config.denylist)
        : DEFAULT_DENY;

    // Context-Token im Speicher halten, damit Warenkorb-Aenderungen konsistent bleiben.
    var contextToken = config.contextToken || null;

    /**
     * Schlanker Fetch-Wrapper fuer die Store-API. Auch fuer Erweiterungs-Tools
     * nutzbar (mcp.storeApi), damit diese dieselbe Auth/Context-Logik bekommen.
     */
    function storeApi(method, path, body) {
        var headers = {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'sw-access-key': config.accessKey
        };
        if (contextToken) {
            headers['sw-context-token'] = contextToken;
        }

        var options = {
            method: method,
            headers: headers,
            credentials: 'same-origin'
        };
        if (body !== undefined && body !== null) {
            options.body = JSON.stringify(body);
        }

        return fetch(config.storeApiUrl + path, options).then(function (response) {
            var token = response.headers.get('sw-context-token');
            if (token) {
                contextToken = token;
            }

            return response.text().then(function (text) {
                var data = null;
                if (text) {
                    try {
                        data = JSON.parse(text);
                    } catch (e) {
                        data = text;
                    }
                }
                if (!response.ok) {
                    var message = 'Store-API Fehler ' + response.status;
                    if (data && data.errors && data.errors.length) {
                        message += ': ' + data.errors.map(function (err) {
                            return err.detail || err.title;
                        }).join('; ');
                    }
                    throw new Error(message);
                }
                return data;
            });
        });
    }

    // --- Schema-Hilfen --------------------------------------------------------

    function escapeRegex(value) {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /** Mustervergleich: "*" als Platzhalter, ohne "*" als Teilstring-Treffer. */
    function patternMatches(pattern, target) {
        if (!pattern || !target) {
            return false;
        }
        pattern = String(pattern).toLowerCase();
        target = String(target).toLowerCase();
        if (pattern.indexOf('*') === -1) {
            return target.indexOf(pattern) !== -1;
        }
        var regex = new RegExp('^' + pattern.split('*').map(escapeRegex).join('.*') + '$');
        return regex.test(target);
    }

    function anyMatch(patterns, op) {
        for (var i = 0; i < patterns.length; i++) {
            if (patternMatches(patterns[i], op.name)
                || patternMatches(patterns[i], op.method + ' ' + op.path)
                || patternMatches(patterns[i], op.path)) {
                return true;
            }
        }
        return false;
    }

    /** Loest einen lokalen JSON-Pointer ("#/components/...") im Dokument auf. */
    function resolvePointer(doc, ref) {
        if (typeof ref !== 'string' || ref.indexOf('#/') !== 0) {
            return {};
        }
        var parts = ref.substring(2).split('/');
        var node = doc;
        for (var i = 0; i < parts.length; i++) {
            var key = parts[i].replace(/~1/g, '/').replace(/~0/g, '~');
            node = node && node[key];
        }
        return node || {};
    }

    /** Loest $ref rekursiv auf (Tiefenlimit gegen Zyklen/aufgeblaehte Schemata). */
    function derefSchema(doc, schema, depth) {
        if (!schema || typeof schema !== 'object') {
            return schema;
        }
        if (depth > 4) {
            return {};
        }
        if (schema.$ref) {
            return derefSchema(doc, resolvePointer(doc, schema.$ref), depth + 1);
        }
        var out = Array.isArray(schema) ? [] : {};
        Object.keys(schema).forEach(function (key) {
            var value = schema[key];
            out[key] = (value && typeof value === 'object') ? derefSchema(doc, value, depth + 1) : value;
        });
        return out;
    }

    function sanitizeName(value) {
        var name = String(value)
            .replace(/[^a-zA-Z0-9_-]/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_+|_+$/g, '');
        if (!name) {
            name = 'op';
        }
        if (!/^[a-zA-Z_]/.test(name)) {
            name = 'op_' + name;
        }
        return name.slice(0, 64);
    }

    function uniqueName(base, used) {
        var name = base;
        var i = 2;
        while (used[name]) {
            name = base + '_' + i;
            i += 1;
        }
        used[name] = true;
        return name;
    }

    /** Baut aus einer OpenAPI-Operation eine Tool-Spezifikation (name/desc/schema/run). */
    function buildOperationTool(doc, path, method, op, used) {
        var name = uniqueName(sanitizeName(op.operationId || (method + '-' + path)), used);
        var summary = op.summary || op.description || (method.toUpperCase() + ' ' + path);

        var parameters = (op.parameters || []).map(function (param) {
            return param && param.$ref ? resolvePointer(doc, param.$ref) : param;
        }).filter(Boolean);

        var pathParams = parameters.filter(function (p) { return p.in === 'path'; });
        var queryParams = parameters.filter(function (p) { return p.in === 'query'; });

        var properties = {};
        var required = [];

        pathParams.concat(queryParams).forEach(function (p) {
            var schema = derefSchema(doc, p.schema || { type: 'string' }, 0) || {};
            if (p.description && !schema.description) {
                schema.description = p.description;
            }
            properties[p.name] = schema;
            if (p.required) {
                required.push(p.name);
            }
        });

        var hasBody = false;
        if (op.requestBody) {
            var rb = op.requestBody.$ref ? resolvePointer(doc, op.requestBody.$ref) : op.requestBody;
            var content = rb && rb.content && (rb.content['application/json'] || rb.content[Object.keys(rb.content || {})[0]]);
            if (content && content.schema) {
                var bodySchema = derefSchema(doc, content.schema, 0) || {};
                if (!bodySchema.description) {
                    bodySchema.description = 'JSON request body for this operation.';
                }
                properties.body = bodySchema;
                hasBody = true;
                if (rb.required) {
                    required.push('body');
                }
            }
        }

        var cleanPath = path.replace(/^\/store-api/, '');
        var pathNames = pathParams.map(function (p) { return p.name; });
        var queryNames = queryParams.map(function (p) { return p.name; });
        var upperMethod = method.toUpperCase();

        var inputSchema = { type: 'object', properties: properties };
        if (required.length) {
            inputSchema.required = required;
        }

        return {
            name: name,
            description: (summary + ' [' + upperMethod + ' ' + path + ']').slice(0, 1024),
            inputSchema: inputSchema,
            __op: { name: name, method: method, path: path },
            run: function (args) {
                args = args || {};
                var url = cleanPath;
                pathNames.forEach(function (n) {
                    url = url.replace('{' + n + '}', encodeURIComponent(args[n] != null ? args[n] : ''));
                });
                var qs = [];
                queryNames.forEach(function (n) {
                    if (args[n] != null) {
                        qs.push(encodeURIComponent(n) + '=' + encodeURIComponent(args[n]));
                    }
                });
                if (qs.length) {
                    url += (url.indexOf('?') === -1 ? '?' : '&') + qs.join('&');
                }
                var body = hasBody ? args.body : null;
                return storeApi(upperMethod, url, body);
            }
        };
    }

    function passesFilter(spec) {
        var op = spec.__op;
        if (!includeMutations && ['put', 'patch', 'delete'].indexOf(op.method) !== -1) {
            return false;
        }
        if (allowlist.length && !anyMatch(allowlist, op)) {
            return false;
        }
        if (denylist.length && anyMatch(denylist, op)) {
            return false;
        }
        return true;
    }

    // --- Registry & WebMCP-Verdrahtung ---------------------------------------

    // Tool-Spezifikationen (schema-generiert + Erweiterungen). Jede Spec bekommt
    // unter __webmcp ihr fertig gebautes WebMCP-Tool-Objekt.
    var registry = [];

    function toToolResult(data) {
        return {
            content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
            structuredContent: data
        };
    }

    function toToolError(error) {
        return {
            isError: true,
            content: [{ type: 'text', text: 'Fehler: ' + (error && error.message ? error.message : String(error)) }]
        };
    }

    function buildWebMcpTool(spec) {
        var execute = typeof spec.execute === 'function'
            ? spec.execute
            : function (args) {
                return Promise.resolve()
                    .then(function () { return spec.run(args || {}); })
                    .then(toToolResult)
                    .catch(toToolError);
            };

        return {
            name: spec.name,
            description: spec.description,
            inputSchema: spec.inputSchema || { type: 'object', properties: {} },
            execute: execute
        };
    }

    function internalRegister(spec) {
        if (!spec || typeof spec.name !== 'string' || !spec.name) {
            console.warn('[WebMCP] Tool ohne gueltigen Namen ignoriert.', spec);
            return;
        }
        if (typeof spec.run !== 'function' && typeof spec.execute !== 'function') {
            console.warn('[WebMCP] Tool "' + spec.name + '" ohne run()/execute() ignoriert.');
            return;
        }
        spec.__webmcp = buildWebMcpTool(spec);

        // Gleichnamiges Tool ersetzen (erlaubt Override durch andere Plugins).
        for (var i = 0; i < registry.length; i++) {
            if (registry[i].name === spec.name) {
                registry[i] = spec;
                return;
            }
        }
        registry.push(spec);
    }

    function ensureModelContext() {
        if (navigator.modelContext) {
            return navigator.modelContext;
        }

        var registered = [];
        var polyfill = {
            __isPolyfill: true,
            _tools: registered,
            registerTool: function (tool) {
                registered.push(tool);
                return function unregister() {
                    var index = registered.indexOf(tool);
                    if (index >= 0) {
                        registered.splice(index, 1);
                    }
                };
            },
            provideContext: function (ctx) {
                registered.length = 0;
                if (ctx && Array.isArray(ctx.tools)) {
                    ctx.tools.forEach(function (tool) {
                        registered.push(tool);
                    });
                }
            }
        };

        try {
            Object.defineProperty(navigator, 'modelContext', {
                value: polyfill,
                configurable: true,
                writable: false
            });
        } catch (e) {
            window.modelContext = polyfill;
        }

        return navigator.modelContext || polyfill;
    }

    var modelContext = ensureModelContext();
    var activeUnregister = [];

    function applyToModelContext(toolObjects) {
        try {
            if (typeof modelContext.provideContext === 'function') {
                modelContext.provideContext({ tools: toolObjects });
            } else if (typeof modelContext.registerTool === 'function') {
                activeUnregister.forEach(function (fn) {
                    try { fn(); } catch (e) { /* ignorieren */ }
                });
                activeUnregister = toolObjects.map(function (tool) {
                    return modelContext.registerTool(tool) || function () {};
                });
            }
        } catch (e) {
            console.error('[WebMCP] Konnte Tools nicht publizieren:', e);
        }
    }

    var publishScheduled = false;

    function schedulePublish() {
        if (publishScheduled) {
            return;
        }
        publishScheduled = true;
        Promise.resolve().then(function () {
            publishScheduled = false;
            publish();
        });
    }

    function publish() {
        // Verfuegbarkeit jeder Spec auswerten (optionales isAvailable-Gate).
        var checks = registry.map(function (spec) {
            if (typeof spec.isAvailable !== 'function') {
                return Promise.resolve({ spec: spec, ok: true });
            }
            return Promise.resolve()
                .then(function () { return spec.isAvailable(); })
                .then(function (ok) { return { spec: spec, ok: !!ok }; })
                .catch(function () { return { spec: spec, ok: false }; });
        });

        Promise.all(checks).then(function (results) {
            var active = results
                .filter(function (r) { return r.ok; })
                .map(function (r) { return r.spec.__webmcp; });

            applyToModelContext(active);

            var names = active.map(function (tool) { return tool.name; });
            window.dispatchEvent(new CustomEvent('webmcp:ready', { detail: { tools: names } }));
            console.info('[WebMCP] ' + names.length + ' Tools aktiv.');
        });
    }

    // --- Oeffentliche Erweiterungs-API + Command-Queue -----------------------

    var api = {
        version: '2.0.0',
        config: config,
        storeApi: storeApi,
        registerTool: function (spec) {
            internalRegister(spec);
            schedulePublish();
            var name = spec && spec.name;
            return function unregister() {
                api.unregisterTool(name);
            };
        },
        unregisterTool: function (name) {
            for (var i = 0; i < registry.length; i++) {
                if (registry[i].name === name) {
                    registry.splice(i, 1);
                    schedulePublish();
                    return true;
                }
            }
            return false;
        },
        getTools: function () {
            return registry.map(function (spec) { return spec.name; });
        },
        callTool: function (name, args) {
            for (var i = 0; i < registry.length; i++) {
                if (registry[i].name === name) {
                    return registry[i].__webmcp.execute(args || {});
                }
            }
            return Promise.reject(new Error('Unbekanntes Tool: ' + name));
        },
        refresh: function () {
            schedulePublish();
        },
        push: function (callback) {
            if (typeof callback === 'function') {
                try {
                    callback(api);
                } catch (e) {
                    console.error('[WebMCP] Fehler in Erweiterungs-Callback:', e);
                }
            }
            return api;
        }
    };

    // Eventuell vor dem Core geladene Erweiterungen standen als Array-Queue bereit.
    var pending = window.SwagWebMcp;
    window.SwagWebMcp = api;
    window.swagWebMcp = api; // Alias (Abwaertskompatibilitaet)

    // Gepufferte Erweiterungs-Callbacks abarbeiten (handkuratierte Tools).
    if (pending && typeof pending.length === 'number') {
        Array.prototype.slice.call(pending).forEach(function (callback) {
            api.push(callback);
        });
    }

    window.dispatchEvent(new CustomEvent('swag-web-mcp:ready', { detail: { mcp: api } }));

    // --- Schema-getriebene Tool-Generierung ----------------------------------

    function loadSchemaTools() {
        if (!schemaDriven) {
            console.info('[WebMCP] Schema-Generierung deaktiviert (nur Erweiterungs-Tools).');
            schedulePublish();
            return;
        }

        storeApi('GET', '/_info/openapi3.json', null).then(function (doc) {
            if (!doc || !doc.paths) {
                console.warn('[WebMCP] Store-API-Schema leer oder unerwartet – keine Tools generiert.');
                schedulePublish();
                return;
            }

            var used = {};
            var generated = [];
            Object.keys(doc.paths).forEach(function (path) {
                var item = doc.paths[path] || {};
                ['get', 'post', 'put', 'patch', 'delete'].forEach(function (method) {
                    if (item[method]) {
                        generated.push(buildOperationTool(doc, path, method, item[method], used));
                    }
                });
            });

            var filtered = generated.filter(passesFilter);
            if (filtered.length > maxTools) {
                filtered = filtered.slice(0, maxTools);
            }
            filtered.forEach(internalRegister);
            schedulePublish();

            console.info('[WebMCP] ' + filtered.length + ' von ' + generated.length
                + ' Store-API-Operationen als Tools registriert'
                + (filtered.length === maxTools ? ' (auf maxTools=' + maxTools + ' begrenzt)' : '') + '.');
        }).catch(function (error) {
            console.warn('[WebMCP] Konnte Store-API-Schema nicht laden:', error && error.message);
            schedulePublish();
        });
    }

    // Erste Publikation (Erweiterungs-Tools), danach Schema laden + nachpublizieren.
    schedulePublish();
    loadSchemaTools();
})();
