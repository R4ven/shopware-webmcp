/**
 * BEISPIEL: Eigenes, handkuratiertes WebMCP-Tool
 * ==============================================
 * Die Tools werden primaer automatisch aus dem Store-API-Schema generiert.
 * Die Erweiterungs-API bleibt trotzdem nuetzlich fuer Tools, die es im Schema
 * NICHT als einzelne Operation gibt – z. B. zusammengesetzte Ablaeufe oder
 * Tools mit aufgeraeumter, agentenfreundlicher Ein-/Ausgabe.
 *
 * Auslieferung im eigenen Plugin:
 *   1. Datei nach <DeinPlugin>/src/Resources/public/dein-tool.js legen.
 *   2. Im eigenen base.html.twig (sw_extends '@Storefront/storefront/base.html.twig')
 *      per base_body_inner + parent() einbinden:
 *        <script src="{{ asset('bundles/deinplugin/dein-tool.js') }}" defer></script>
 *
 * Die Command-Queue ist ladereihenfolge-unabhaengig.
 */
(function () {
    'use strict';

    (window.SwagWebMcp = window.SwagWebMcp || []).push(function (mcp) {

        // Zusammengesetztes Tool: sucht ein Produkt und legt den ersten Treffer
        // direkt in den Warenkorb – ein Ablauf, den das Schema so nicht anbietet.
        mcp.registerTool({
            name: 'quick_buy',
            description: 'Sucht ein Produkt anhand eines Begriffs und legt den besten Treffer in den Warenkorb.',
            inputSchema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Suchbegriff fuer das gewuenschte Produkt.' },
                    quantity: { type: 'integer', description: 'Menge (Standard 1).', minimum: 1 }
                },
                required: ['query']
            },
            run: function (args) {
                return mcp.storeApi('POST', '/search', { search: args.query, limit: 1 })
                    .then(function (result) {
                        var product = result && result.elements && result.elements[0];
                        if (!product) {
                            return { added: false, reason: 'Kein Produkt fuer "' + args.query + '" gefunden.' };
                        }
                        return mcp.storeApi('POST', '/checkout/cart/line-item', {
                            items: [{ type: 'product', referencedId: product.id, quantity: args.quantity || 1 }]
                        }).then(function (cart) {
                            return {
                                added: true,
                                product: { id: product.id, name: (product.translated && product.translated.name) || product.name },
                                cartItemCount: (cart.lineItems || []).length,
                                cartTotal: cart.price && cart.price.totalPrice
                            };
                        });
                    });
            }
        });

        // Tipp: Mit mcp.unregisterTool('<name>') lassen sich auch automatisch
        // generierte Schema-Tools gezielt entfernen oder per gleichnamigem
        // registerTool durch eine kuratierte Variante ersetzen.
    });
})();
