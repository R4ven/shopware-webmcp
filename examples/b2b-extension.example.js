/**
 * BEISPIEL: WebMCP-Erweiterung fuer ein B2B-Plugin
 * ================================================
 * So steuert ein eigenstaendiges Plugin (z. B. fuer Shopware B2B Commerce mit
 * Employees) zusaetzliche MCP-Tools bei, OHNE das Core-Plugin SwagWebMcp zu
 * aendern.
 *
 * Auslieferung im eigenen Plugin:
 *   1. Diese Datei nach <DeinPlugin>/src/Resources/public/dein-b2b-mcp.js legen.
 *   2. Im eigenen base.html.twig (sw_extends '@Storefront/storefront/base.html.twig')
 *      einbinden:
 *        <script src="{{ asset('bundles/deinb2bplugin/dein-b2b-mcp.js') }}" defer></script>
 *      Optional B2B-Kontext in die Config geben (Block aus SwagWebMcp nutzen):
 *        {% block swag_web_mcp_config_extend %}
 *          window.swagWebMcpConfig.b2b = {
 *              enabled: {{ b2bActive ? 'true' : 'false' }},
 *              permissions: {{ employeePermissions|json_encode|raw }}
 *          };
 *        {% endblock %}
 *
 * Die Command-Queue ist ladereihenfolge-unabhaengig: Es ist egal, ob dieses
 * Skript vor oder nach dem Core-Skript ausgefuehrt wird.
 */
(function () {
    'use strict';

    (window.SwagWebMcp = window.SwagWebMcp || []).push(function (mcp) {
        var b2b = (mcp.config && mcp.config.b2b) || {};

        // Hilfsfunktion: Pruefen, ob der eingeloggte Employee eine Berechtigung hat.
        function hasPermission(permission) {
            if (!b2b.enabled || !mcp.config.loggedIn) {
                return false;
            }
            // Wenn keine Permission-Liste geliefert wurde, B2B als aktiv annehmen.
            if (!Array.isArray(b2b.permissions)) {
                return true;
            }
            return b2b.permissions.indexOf(permission) !== -1;
        }

        // Beispiel 1: Bestellhistorie der Firma — nur fuer Employees mit Leserecht.
        mcp.registerTool({
            name: 'b2b_list_orders',
            description: 'Listet die Bestellungen des B2B-Kontos (Firma) des angemeldeten Employees auf.',
            inputSchema: {
                type: 'object',
                properties: {
                    limit: { type: 'integer', description: 'Maximale Anzahl (Standard 10).', minimum: 1, maximum: 50 }
                }
            },
            isAvailable: function () {
                return hasPermission('order.read');
            },
            run: function (args) {
                // Hinweis: Route ist je nach B2B-Plugin/Version anzupassen.
                return mcp.storeApi('POST', '/order', {
                    limit: args.limit || 10,
                    'total-count-mode': 1
                }).then(function (result) {
                    var orders = (result && result.orders && result.orders.elements) || [];
                    return {
                        total: result && result.orders ? result.orders.total : orders.length,
                        orders: orders.map(function (order) {
                            return {
                                id: order.id,
                                orderNumber: order.orderNumber,
                                amountTotal: order.amountTotal,
                                state: order.stateMachineState && order.stateMachineState.technicalName,
                                orderDate: order.orderDateTime
                            };
                        })
                    };
                });
            }
        });

        // Beispiel 2: Angebot/Quote anfragen — nur mit entsprechender Berechtigung.
        mcp.registerTool({
            name: 'b2b_request_quote',
            description: 'Wandelt den aktuellen Warenkorb in eine Angebotsanfrage (Quote) um.',
            inputSchema: {
                type: 'object',
                properties: {
                    comment: { type: 'string', description: 'Optionaler Kommentar an den Vertrieb.' }
                }
            },
            isAvailable: function () {
                return hasPermission('quote.create');
            },
            run: function (args) {
                // Hinweis: Route ist je nach B2B-Plugin/Version anzupassen.
                return mcp.storeApi('POST', '/quote/request', {
                    comment: args.comment || ''
                });
            }
        });

        // Beispiel 3: In einer reinen B2B-Storefront koennen unpassende Core-Tools
        // entfernt werden (z. B. wenn Self-Service-Checkout gesperrt ist):
        // if (b2b.enabled && b2b.checkoutLocked) {
        //     mcp.unregisterTool('add_to_cart');
        //     mcp.unregisterTool('update_cart_item');
        // }

        // Nachdem sich z. B. nach einem Login die Berechtigungen aendern, kann ein
        // erneutes Auswerten der isAvailable-Gates angestossen werden:
        // mcp.refresh();
    });
})();
