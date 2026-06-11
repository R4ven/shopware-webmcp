<?php declare(strict_types=1);

namespace Swag\WebMcpB2b;

use Shopware\Core\Framework\Plugin;

/**
 * Begleit-Plugin zu SwagWebMcp.
 *
 * Liefert ausschliesslich ein Storefront-JavaScript aus (Resources/public),
 * das sich ueber die Erweiterungs-API (window.SwagWebMcp) des Basis-Plugins
 * einklinkt und B2B-Commerce-Tools registriert. Es werden keine eigenen
 * Services, Routen oder Migrationen benoetigt.
 */
class SwagWebMcpB2b extends Plugin
{
}
