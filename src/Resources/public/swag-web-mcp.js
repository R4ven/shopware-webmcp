/**
 * Shopware Storefront WebMCP Bootstrap
 * ------------------------------------
 * Registriert beim Laden der Seite eine Reihe von MCP-Tools ueber die
 * WebMCP-API (navigator.modelContext), sodass jeder Browser-Agent im Shop
 * sofort eine fertige Schnittstelle zum Suchen, Stoebern und Bestellen hat.
 *
 * Die Tools rufen im Hintergrund die Shopware Store-API auf und arbeiten dabei
 * auf demselben Warenkorb/Context wie die laufende Session.
 *
 * Falls der Browser/Agent die WebMCP-API noch nicht nativ unterstuetzt, wird
 * ein leichtgewichtiges Polyfill installiert, das die Tools trotzdem unter
 * navigator.modelContext und window.swagWebMcp auffindbar macht.
 */
(function () {
    'use strict';

    var config = window.swagWebMcpConfig || {};

    if (!config.storeApiUrl || !config.accessKey) {
        // Ohne Store-API-Zugang koennen wir nichts ausliefern.
        console.warn('[WebMCP] Fehlende Konfiguration (storeApiUrl/accessKey) – Tools werden nicht registriert.');
        return;
    }

    // Context-Token im Speicher halten, damit Warenkorb-Aenderungen konsistent bleiben.
    var contextToken = config.contextToken || null;

    /**
     * Schlanker Fetch-Wrapper fuer die Store-API.
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
            // Aktualisiertes Context-Token uebernehmen (z. B. nach erster Cart-Aenderung).
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

    // --- Mapper / Helfer -----------------------------------------------------

    function formatMoney(amount) {
        if (typeof amount !== 'number') {
            return String(amount);
        }
        var currency = config.currencyCode || '';
        return amount.toFixed(2) + (currency ? ' ' + currency : '');
    }

    function productPrice(product) {
        if (!product) {
            return null;
        }
        if (product.calculatedPrice && typeof product.calculatedPrice.unitPrice === 'number') {
            return product.calculatedPrice.unitPrice;
        }
        if (product.calculatedCheapestPrice && typeof product.calculatedCheapestPrice.unitPrice === 'number') {
            return product.calculatedCheapestPrice.unitPrice;
        }
        return null;
    }

    function mapProduct(product) {
        if (!product) {
            return null;
        }
        var price = productPrice(product);
        return {
            id: product.id,
            productNumber: product.productNumber,
            name: (product.translated && product.translated.name) || product.name,
            description: (product.translated && product.translated.description) || product.description || null,
            price: price,
            priceFormatted: price !== null ? formatMoney(price) : null,
            available: product.available !== false,
            stock: typeof product.availableStock === 'number' ? product.availableStock : null
        };
    }

    function mapCart(cart) {
        if (!cart) {
            return null;
        }
        var items = (cart.lineItems || []).map(function (item) {
            return {
                lineItemId: item.id,
                referencedId: item.referencedId,
                label: item.label,
                quantity: item.quantity,
                unitPrice: item.price ? item.price.unitPrice : null,
                totalPrice: item.price ? item.price.totalPrice : null,
                totalPriceFormatted: item.price ? formatMoney(item.price.totalPrice) : null
            };
        });
        var total = cart.price ? cart.price.totalPrice : null;
        return {
            token: cart.token,
            itemCount: items.length,
            lineItems: items,
            total: total,
            totalFormatted: total !== null ? formatMoney(total) : null
        };
    }

    // --- Tool-Definitionen ---------------------------------------------------

    var tools = [
        {
            name: 'search_products',
            description: 'Sucht Produkte im Shop anhand eines Suchbegriffs und liefert Name, Preis und Produkt-ID.',
            inputSchema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Der Suchbegriff, z. B. "Sommerjacke".' },
                    limit: { type: 'integer', description: 'Maximale Trefferzahl (Standard 10).', minimum: 1, maximum: 50 }
                },
                required: ['query']
            },
            run: function (args) {
                return storeApi('POST', '/search', {
                    search: args.query,
                    limit: args.limit || 10
                }).then(function (result) {
                    var elements = (result && result.elements) || [];
                    return {
                        total: result ? result.total : elements.length,
                        products: elements.map(mapProduct)
                    };
                });
            }
        },
        {
            name: 'get_product',
            description: 'Liefert Detailinformationen zu einem Produkt anhand seiner Produkt-ID.',
            inputSchema: {
                type: 'object',
                properties: {
                    productId: { type: 'string', description: 'Die ID des Produkts (z. B. aus search_products).' }
                },
                required: ['productId']
            },
            run: function (args) {
                return storeApi('POST', '/product/' + encodeURIComponent(args.productId), {}).then(function (result) {
                    var product = result && (result.product || result);
                    return { product: mapProduct(product) };
                });
            }
        },
        {
            name: 'list_categories',
            description: 'Liefert die Hauptnavigation/Kategorien des Shops, um durch das Sortiment zu navigieren.',
            inputSchema: {
                type: 'object',
                properties: {
                    depth: { type: 'integer', description: 'Verschachtelungstiefe (Standard 2).', minimum: 1, maximum: 3 }
                }
            },
            run: function (args) {
                return storeApi('POST', '/navigation/main-navigation/main-navigation', {
                    depth: args.depth || 2
                }).then(function (result) {
                    var elements = (result && (result.elements || result)) || [];
                    return {
                        categories: elements.map(function (cat) {
                            return {
                                id: cat.id,
                                name: (cat.translated && cat.translated.name) || cat.name,
                                childCount: cat.childCount || 0,
                                level: cat.level
                            };
                        })
                    };
                });
            }
        },
        {
            name: 'get_cart',
            description: 'Zeigt den aktuellen Warenkorb mit Positionen, Mengen und Gesamtsumme.',
            inputSchema: { type: 'object', properties: {} },
            run: function () {
                return storeApi('GET', '/checkout/cart', null).then(function (cart) {
                    return mapCart(cart);
                });
            }
        },
        {
            name: 'add_to_cart',
            description: 'Legt ein Produkt in den Warenkorb. Erwartet die Produkt-ID und optional eine Menge.',
            inputSchema: {
                type: 'object',
                properties: {
                    productId: { type: 'string', description: 'Die ID des hinzuzufuegenden Produkts.' },
                    quantity: { type: 'integer', description: 'Menge (Standard 1).', minimum: 1 }
                },
                required: ['productId']
            },
            run: function (args) {
                return storeApi('POST', '/checkout/cart/line-item', {
                    items: [{
                        type: 'product',
                        referencedId: args.productId,
                        quantity: args.quantity || 1
                    }]
                }).then(function (cart) {
                    return mapCart(cart);
                });
            }
        },
        {
            name: 'update_cart_item',
            description: 'Aendert die Menge einer Warenkorb-Position. Erwartet die lineItemId (aus get_cart) und die neue Menge.',
            inputSchema: {
                type: 'object',
                properties: {
                    lineItemId: { type: 'string', description: 'Die ID der Warenkorb-Position.' },
                    quantity: { type: 'integer', description: 'Die neue Menge.', minimum: 1 }
                },
                required: ['lineItemId', 'quantity']
            },
            run: function (args) {
                return storeApi('PATCH', '/checkout/cart/line-item', {
                    items: [{
                        id: args.lineItemId,
                        quantity: args.quantity
                    }]
                }).then(function (cart) {
                    return mapCart(cart);
                });
            }
        },
        {
            name: 'remove_from_cart',
            description: 'Entfernt eine Position aus dem Warenkorb. Erwartet die lineItemId aus get_cart.',
            inputSchema: {
                type: 'object',
                properties: {
                    lineItemId: { type: 'string', description: 'Die ID der zu entfernenden Warenkorb-Position.' }
                },
                required: ['lineItemId']
            },
            run: function (args) {
                return storeApi('DELETE', '/checkout/cart/line-item', {
                    ids: [args.lineItemId]
                }).then(function (cart) {
                    return mapCart(cart);
                });
            }
        }
    ];

    // --- WebMCP-Verdrahtung ---------------------------------------------------

    /**
     * Verpackt das Ergebnis einer Tool-Ausfuehrung ins WebMCP-Antwortformat.
     */
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

    /**
     * Baut eine WebMCP-Tool-Definition mit async execute() aus unserer Tool-Spezifikation.
     */
    function toWebMcpTool(spec) {
        return {
            name: spec.name,
            description: spec.description,
            inputSchema: spec.inputSchema,
            execute: function (args) {
                return Promise.resolve()
                    .then(function () {
                        return spec.run(args || {});
                    })
                    .then(toToolResult)
                    .catch(toToolError);
            }
        };
    }

    /**
     * Stellt navigator.modelContext sicher – nutzt die native API oder installiert
     * ein minimales Polyfill, damit die Tools auffindbar bleiben.
     */
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

    var webMcpTools = tools.map(toWebMcpTool);
    var modelContext = ensureModelContext();

    // Bevorzugt provideContext (deklariert das gesamte Tool-Set auf einmal),
    // faellt sonst auf einzelne registerTool-Aufrufe zurueck.
    try {
        if (typeof modelContext.provideContext === 'function') {
            modelContext.provideContext({ tools: webMcpTools });
        } else if (typeof modelContext.registerTool === 'function') {
            webMcpTools.forEach(function (tool) {
                modelContext.registerTool(tool);
            });
        }
    } catch (e) {
        console.error('[WebMCP] Konnte Tools nicht registrieren:', e);
    }

    // Zusaetzlicher, einfacher Zugriffspunkt fuer Agenten/Erweiterungen, die
    // (noch) nicht auf navigator.modelContext setzen.
    window.swagWebMcp = {
        version: '1.0.0',
        tools: webMcpTools,
        config: { salesChannelName: config.salesChannelName, currencyCode: config.currencyCode },
        callTool: function (name, args) {
            var match = webMcpTools.filter(function (tool) {
                return tool.name === name;
            })[0];
            if (!match) {
                return Promise.reject(new Error('Unbekanntes Tool: ' + name));
            }
            return match.execute(args || {});
        }
    };

    window.dispatchEvent(new CustomEvent('webmcp:ready', {
        detail: { tools: webMcpTools.map(function (tool) { return tool.name; }) }
    }));

    console.info('[WebMCP] ' + webMcpTools.length + ' Tools fuer Agenten registriert:',
        webMcpTools.map(function (tool) { return tool.name; }).join(', '));
})();
