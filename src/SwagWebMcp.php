<?php declare(strict_types=1);

namespace Swag\WebMcp;

use Shopware\Core\Framework\Plugin;

/**
 * Plugin-Basisklasse.
 *
 * Das Plugin benoetigt keine eigenen Services oder Migrationen: Es haengt sich
 * ausschliesslich ueber das Twig-Template (Resources/views/storefront/base.html.twig)
 * in die Storefront ein und liefert das WebMCP-JavaScript als statisches Asset
 * (Resources/public) aus. Beides wird von Shopware automatisch geladen.
 */
class SwagWebMcp extends Plugin
{
}
