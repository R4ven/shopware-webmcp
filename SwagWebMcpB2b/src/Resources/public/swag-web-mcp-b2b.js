/**
 * WebMCP B2B Commerce Tools
 * =========================
 * Begleit-Skript zu SwagWebMcp. Registriert zusaetzliche MCP-Tools fuer
 * Shopware B2B Commerce (Quote-Management, Employees, Organisationseinheiten)
 * ueber die Erweiterungs-API window.SwagWebMcp.
 *
 * SELBST-ADAPTIV / BERECHTIGUNGSABHAENGIG
 * ---------------------------------------
 * Das B2B-Funktionsset haengt von der installierten Commercial-Version und der
 * Rolle des angemeldeten Employees ab (nicht alle Routen sind fuer jeden
 * verfuegbar). Statt feste Annahmen zu treffen, ermittelt jedes Tool seine
 * Verfuegbarkeit ueber einen einmaligen, lesenden Probe-Aufruf der jeweiligen
 * Route:
 *   - Antwortet die Route erfolgreich  -> Tool wird dem Agenten angeboten.
 *   - 401/403/404 (nicht eingeloggt, keine Berechtigung, Route existiert nicht)
 *                                       -> Tool bleibt ausgeblendet.
 * Dadurch passt sich das Plugin automatisch an den jeweiligen Shop an und
 * bricht nicht, falls ein Routen-Pfad in einer Version abweicht.
 *
 * ROUTEN VERIFIZIEREN
 * -------------------
 * Die Pfade unten entsprechen dem bekannten Stand der B2B-Commerce-Store-API.
 * Da das Commercial-Plugin Closed Source ist und Routen je Version abweichen
 * koennen, im Zweifel gegen die offizielle Doku pruefen:
 *   - Quote Management:  https://developer.shopware.com/docs/products/extensions/b2b-components/quotes-management/
 *   - Employee Management: https://developer.shopware.com/docs/products/extensions/b2b-components/employee-management/
 *   - Organization Unit:  https://developer.shopware.com/docs/products/extensions/b2b-components/organization-unit/guides/store-api.html
 * Anpassungen erfolgen ausschliesslich in der ROUTES-Map unten.
 */
(function () {
    'use strict';

    // --- Zentrale Routen-Map (hier bei Bedarf an die eigene Version anpassen) ---
    var ROUTES = {
        quotesList:         { method: 'GET',  path: '/quote' },
        quoteDetail:        function (id) { return '/quote/' + encodeURIComponent(id); },
        quoteRequest:       { method: 'POST', path: '/quote/request' },
        quoteDecline:       function (id) { return '/quote/' + encodeURIComponent(id) + '/decline'; },
        quoteRequestChange: function (id) { return '/quote/' + encodeURIComponent(id) + '/request-change'; },
        employeeList:       { method: 'GET',  path: '/employee' },
        organizationUnits:  { method: 'GET',  path: '/organization-units' }
    };

    (window.SwagWebMcp = window.SwagWebMcp || []).push(function (mcp) {

        // Einmalige, gecachte Verfuegbarkeitspruefung pro Feature-Route.
        var probeCache = {};

        function probe(key, route) {
            if (!mcp.config.loggedIn) {
                // Alle B2B-Routen sind account-gebunden – ohne Login keine Tools.
                return Promise.resolve(false);
            }
            if (!probeCache[key]) {
                probeCache[key] = mcp.storeApi(route.method, route.path, route.method === 'GET' ? null : {})
                    .then(function () { return true; })
                    .catch(function (error) {
                        // Berechtigung/Route nicht vorhanden -> Tool ausblenden.
                        console.debug('[WebMCP-B2B] "' + key + '" nicht verfuegbar:', error && error.message);
                        return false;
                    });
            }
            return probeCache[key];
        }

        function quotesAvailable() { return probe('quotes', ROUTES.quotesList); }
        function employeesAvailable() { return probe('employees', ROUTES.employeeList); }
        function organizationUnitsAvailable() { return probe('organizationUnits', ROUTES.organizationUnits); }

        function listFrom(result, key) {
            if (!result) { return []; }
            if (Array.isArray(result.elements)) { return result.elements; }
            if (result[key] && Array.isArray(result[key].elements)) { return result[key].elements; }
            if (Array.isArray(result[key])) { return result[key]; }
            return [];
        }

        // --- Quote-Management -------------------------------------------------

        mcp.registerTool({
            name: 'b2b_list_quotes',
            description: 'Listet die Angebote (Quotes) des B2B-Kontos des angemeldeten Employees auf.',
            inputSchema: {
                type: 'object',
                properties: {
                    limit: { type: 'integer', description: 'Maximale Anzahl (Standard 10).', minimum: 1, maximum: 50 }
                }
            },
            isAvailable: quotesAvailable,
            run: function (args) {
                var body = { limit: (args && args.limit) || 10, 'total-count-mode': 1 };
                return mcp.storeApi('POST', ROUTES.quotesList.path, body).then(function (result) {
                    var quotes = listFrom(result, 'quotes');
                    return {
                        total: (result && (result.total || (result.quotes && result.quotes.total))) || quotes.length,
                        quotes: quotes.map(function (q) {
                            return {
                                id: q.id,
                                quoteNumber: q.quoteNumber,
                                amountTotal: q.amountTotal,
                                state: q.stateMachineState && q.stateMachineState.technicalName,
                                createdAt: q.createdAt
                            };
                        })
                    };
                });
            }
        });

        mcp.registerTool({
            name: 'b2b_get_quote',
            description: 'Liefert die Details eines Angebots (Quote) inkl. Positionen anhand seiner ID.',
            inputSchema: {
                type: 'object',
                properties: {
                    quoteId: { type: 'string', description: 'Die ID des Angebots (aus b2b_list_quotes).' }
                },
                required: ['quoteId']
            },
            isAvailable: quotesAvailable,
            run: function (args) {
                return mcp.storeApi('GET', ROUTES.quoteDetail(args.quoteId), null).then(function (result) {
                    var quote = (result && (result.quote || result)) || {};
                    return {
                        id: quote.id,
                        quoteNumber: quote.quoteNumber,
                        state: quote.stateMachineState && quote.stateMachineState.technicalName,
                        amountTotal: quote.amountTotal,
                        lineItems: (quote.lineItems || []).map(function (item) {
                            return {
                                label: item.label,
                                quantity: item.quantity,
                                unitPrice: item.price && item.price.unitPrice,
                                totalPrice: item.price && item.price.totalPrice
                            };
                        })
                    };
                });
            }
        });

        mcp.registerTool({
            name: 'b2b_request_quote',
            description: 'Erstellt aus dem aktuellen Warenkorb eine Angebotsanfrage (Quote) an den Vertrieb.',
            inputSchema: {
                type: 'object',
                properties: {
                    comment: { type: 'string', description: 'Optionaler Kommentar an den Vertrieb.' }
                }
            },
            isAvailable: quotesAvailable,
            run: function (args) {
                return mcp.storeApi('POST', ROUTES.quoteRequest.path, {
                    comment: (args && args.comment) || ''
                });
            }
        });

        mcp.registerTool({
            name: 'b2b_decline_quote',
            description: 'Lehnt ein vorliegendes Angebot (Quote) ab.',
            inputSchema: {
                type: 'object',
                properties: {
                    quoteId: { type: 'string', description: 'Die ID des abzulehnenden Angebots.' },
                    comment: { type: 'string', description: 'Optionaler Ablehnungsgrund.' }
                },
                required: ['quoteId']
            },
            isAvailable: quotesAvailable,
            run: function (args) {
                return mcp.storeApi('POST', ROUTES.quoteDecline(args.quoteId), {
                    comment: (args && args.comment) || ''
                });
            }
        });

        mcp.registerTool({
            name: 'b2b_request_quote_changes',
            description: 'Fordert Aenderungen an einem Angebot an (z. B. Preise, Mengen, Konditionen).',
            inputSchema: {
                type: 'object',
                properties: {
                    quoteId: { type: 'string', description: 'Die ID des Angebots.' },
                    comment: { type: 'string', description: 'Beschreibung der gewuenschten Aenderungen.' }
                },
                required: ['quoteId', 'comment']
            },
            isAvailable: quotesAvailable,
            run: function (args) {
                return mcp.storeApi('POST', ROUTES.quoteRequestChange(args.quoteId), {
                    comment: args.comment
                });
            }
        });

        // --- Employee-Management ---------------------------------------------

        mcp.registerTool({
            name: 'b2b_list_employees',
            description: 'Listet die Employees (Mitarbeiter) des B2B-Kontos auf. Nur fuer berechtigte Employees.',
            inputSchema: {
                type: 'object',
                properties: {
                    limit: { type: 'integer', description: 'Maximale Anzahl (Standard 25).', minimum: 1, maximum: 100 }
                }
            },
            isAvailable: employeesAvailable,
            run: function (args) {
                return mcp.storeApi('GET', ROUTES.employeeList.path + '?limit=' + ((args && args.limit) || 25), null)
                    .then(function (result) {
                        var employees = listFrom(result, 'employees');
                        return {
                            total: (result && result.total) || employees.length,
                            employees: employees.map(function (e) {
                                return {
                                    id: e.id,
                                    firstName: e.firstName,
                                    lastName: e.lastName,
                                    email: e.email,
                                    role: e.role && (e.role.name || e.role.id),
                                    active: e.active
                                };
                            })
                        };
                    });
            }
        });

        // --- Organisationseinheiten ------------------------------------------

        mcp.registerTool({
            name: 'b2b_list_organization_units',
            description: 'Listet die Organisationseinheiten (z. B. Abteilungen/Standorte) des B2B-Kontos auf.',
            inputSchema: { type: 'object', properties: {} },
            isAvailable: organizationUnitsAvailable,
            run: function () {
                return mcp.storeApi('GET', ROUTES.organizationUnits.path, null).then(function (result) {
                    var units = listFrom(result, 'organizationUnits');
                    return {
                        total: (result && result.total) || units.length,
                        organizationUnits: units.map(function (u) {
                            return { id: u.id, name: u.name };
                        })
                    };
                });
            }
        });

        console.info('[WebMCP-B2B] B2B-Commerce-Tools eingehaengt (Verfuegbarkeit wird je Route geprueft).');
    });
})();
