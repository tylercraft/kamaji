<?php
/**
 * Deleting the plugin removes everything it stored, and its cron event.
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

require_once __DIR__ . '/includes/Store.php';

wp_clear_scheduled_hook( 'craftish_care_sweep' );
CraftishCare\Store::delete_everything();
