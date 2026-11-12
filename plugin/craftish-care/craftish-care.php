<?php
/**
 * Plugin Name:       Craftish Care
 * Description:       Lets Craftish see this site's versions and run the updates WordPress itself offers, when Craftish approves them. It can report, update, and forget its keys. Nothing else.
 * Version:           0.2.2
 * Requires at least: 6.6
 * Requires PHP:      8.1
 * Author:            Craftish
 * Author URI:        https://craftish.dev
 * License:           GPL-2.0-or-later
 * Update URI:        https://care.craftish.dev/craftish-care/
 *
 * The contract is kamaji's docs/protocol.md. Every request is signed by Kamaji with Ed25519 and
 * checked in Auth before anything else runs. The Update URI keeps WordPress from ever replacing
 * this plugin with one of the same name from wordpress.org, and names Craftish's own signed
 * release channel instead (includes/Release.php).
 */

namespace CraftishCare;

defined( 'ABSPATH' ) || exit;

const VERSION  = '0.2.2';
const PROTOCOL = 1;
const MIN_WP   = '6.6';
const MIN_PHP  = '8.1';

require_once __DIR__ . '/includes/Store.php';
require_once __DIR__ . '/includes/Auth.php';
require_once __DIR__ . '/includes/Site.php';
require_once __DIR__ . '/includes/Jobs.php';
require_once __DIR__ . '/includes/Release.php';
require_once __DIR__ . '/includes/Endpoints.php';
require_once __DIR__ . '/includes/Admin.php';

register_activation_hook( __FILE__, __NAMESPACE__ . '\\activate' );
register_deactivation_hook( __FILE__, __NAMESPACE__ . '\\deactivate' );

/** The keys file Kamaji built into this copy, if it has one. A self-updated copy doesn't. */
function load_keys_file(): void {
	$keys_file = __DIR__ . '/craftish-care-keys.php';
	if ( is_readable( $keys_file ) ) {
		require_once $keys_file;
	}
}

function release_key_from_file(): ?array {
	load_keys_file();
	return Store::parse_key( 'release', defined( 'CRAFTISH_CARE_RELEASE_KEY_ID' ) ? CRAFTISH_CARE_RELEASE_KEY_ID : null, defined( 'CRAFTISH_CARE_RELEASE_KEY' ) ? CRAFTISH_CARE_RELEASE_KEY : null );
}

/**
 * Copies the public keys from the keys file into options, and refuses without them. After a
 * self-update there's no keys file, so reactivating keeps the keys already stored.
 */
function activate(): void {
	wp_schedule_event_if_absent();
	if ( Store::disconnected_at() ) {
		return; // Stays disconnected: reconnecting means deleting the plugin and installing a fresh copy.
	}
	load_keys_file();
	$report = Store::parse_key( 'report', defined( 'CRAFTISH_CARE_REPORT_KEY_ID' ) ? CRAFTISH_CARE_REPORT_KEY_ID : null, defined( 'CRAFTISH_CARE_REPORT_KEY' ) ? CRAFTISH_CARE_REPORT_KEY : null );
	$update = Store::parse_key( 'update', defined( 'CRAFTISH_CARE_UPDATE_KEY_ID' ) ? CRAFTISH_CARE_UPDATE_KEY_ID : null, defined( 'CRAFTISH_CARE_UPDATE_KEY' ) ? CRAFTISH_CARE_UPDATE_KEY : null );
	if ( ! $report && ! $update && 2 === count( Store::keys() ) ) {
		Store::log( 'activate', null, 'ok, keys kept' );
		return;
	}
	if ( ! $report || ! $update || $report['id'] === $update['id'] ) {
		wp_die(
			esc_html__( 'Craftish Care is missing its keys. Download a fresh copy from Kamaji for this site and install that.' ),
			esc_html__( 'Craftish Care' ),
			array( 'back_link' => true )
		);
	}
	Store::save_keys( $report, $update );
	$release = release_key_from_file();
	if ( $release && ! in_array( $release['id'], array( $report['id'], $update['id'] ), true ) ) {
		Store::save_release_key( $release );
	}
	Store::log( 'activate', null, 'ok' );
}

/**
 * "Replace current with uploaded" doesn't run the activation hook, so an upgrade from 0.1.0
 * picks up the release key here, once. It never replaces one already stored.
 */
function adopt_release_key(): void {
	if ( Store::release_key() || Store::disconnected_at() || ! Store::keys() ) {
		return;
	}
	$release = release_key_from_file();
	if ( $release && ! isset( Store::keys()[ $release['id'] ] ) ) {
		Store::save_release_key( $release );
		Store::log( 'release key', null, 'stored ' . $release['id'] );
	}
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
add_action( 'admin_enqueue_scripts', array( Admin::class, 'enqueue' ) );
// In wp-admin (after the upload) and on Kamaji's requests, never on a visitor's page load.
add_action( 'admin_init', __NAMESPACE__ . '\\adopt_release_key' );
Release::hooks();
