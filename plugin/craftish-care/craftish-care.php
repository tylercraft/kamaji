<?php
/**
 * Plugin Name:       Craftish Care
 * Description:       Lets Craftish see this site's versions and available updates. It can report, and forget its keys. Nothing else.
 * Version:           0.1.0
 * Requires at least: 6.6
 * Requires PHP:      8.1
 * Author:            Craftish
 * Author URI:        https://craftish.dev
 * License:           GPL-2.0-or-later
 * Update URI:        false
 *
 * The contract is kamaji's docs/protocol.md. Every request is signed by Kamaji with Ed25519 and
 * checked in Auth before anything else runs. "Update URI: false" keeps WordPress from ever
 * replacing this plugin with one of the same name from wordpress.org.
 */

namespace CraftishCare;

defined( 'ABSPATH' ) || exit;

const VERSION  = '0.1.0';
const PROTOCOL = 1;
const MIN_WP   = '6.6';
const MIN_PHP  = '8.1';

require_once __DIR__ . '/includes/Store.php';
require_once __DIR__ . '/includes/Auth.php';
require_once __DIR__ . '/includes/Site.php';
require_once __DIR__ . '/includes/Endpoints.php';
require_once __DIR__ . '/includes/Admin.php';

register_activation_hook( __FILE__, __NAMESPACE__ . '\\activate' );
register_deactivation_hook( __FILE__, __NAMESPACE__ . '\\deactivate' );

/** Copies the public keys from the keys file Kamaji built into this copy, and refuses without them. */
function activate(): void {
	wp_schedule_event_if_absent();
	if ( Store::disconnected_at() ) {
		return; // Stays disconnected: reconnecting means deleting the plugin and installing a fresh copy.
	}
	$keys_file = __DIR__ . '/craftish-care-keys.php';
	if ( is_readable( $keys_file ) ) {
		require_once $keys_file;
	}
	$report = Store::parse_key( 'report', defined( 'CRAFTISH_CARE_REPORT_KEY_ID' ) ? CRAFTISH_CARE_REPORT_KEY_ID : null, defined( 'CRAFTISH_CARE_REPORT_KEY' ) ? CRAFTISH_CARE_REPORT_KEY : null );
	$update = Store::parse_key( 'update', defined( 'CRAFTISH_CARE_UPDATE_KEY_ID' ) ? CRAFTISH_CARE_UPDATE_KEY_ID : null, defined( 'CRAFTISH_CARE_UPDATE_KEY' ) ? CRAFTISH_CARE_UPDATE_KEY : null );
	if ( ! $report || ! $update || $report['id'] === $update['id'] ) {
		wp_die(
			esc_html__( 'Craftish Care is missing its keys. Download a fresh copy from Kamaji for this site and install that.' ),
			esc_html__( 'Craftish Care' ),
			array( 'back_link' => true )
		);
	}
	Store::save_keys( $report, $update );
	Store::log( 'activate', null, 'ok' );
}

function deactivate(): void {
	wp_clear_scheduled_hook( 'craftish_care_sweep' );
}

function wp_schedule_event_if_absent(): void {
	if ( ! wp_next_scheduled( 'craftish_care_sweep' ) ) {
		wp_schedule_event( time() + HOUR_IN_SECONDS, 'hourly', 'craftish_care_sweep' );
	}
}

add_action( 'craftish_care_sweep', array( Store::class, 'sweep_nonces' ) );
add_filter( 'rest_pre_dispatch', array( Endpoints::class, 'pre_dispatch' ), 10, 3 );
add_action( 'admin_menu', array( Admin::class, 'menu' ) );
