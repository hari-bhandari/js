var User = Protected.extend({
	base_url: '/users',
	local_table: 'user',

	public_fields: [
		'id',
		'storage',
		'name',
		'pubkey',
	],

	private_fields: [
		'settings',
		'privkey',
	],

	logged_in: false,
	changing_password: false,

	auth: null,

	init: function()
	{
		this.logged_in = false;

		// whenever the user settings change, automatically save them (encrypted).
		this.bind('change:settings', this.save_settings.bind(this), 'user:save_settings');
	},

	login: function(data, options)
	{
		options || (options = {});

		this.set(data);
		var username = this.get('username');
		var password = this.get('password');
		return this.gen_auth(username, password, options).bind(this)
			.then(function(auth) {
				this.logged_in = true;

				// now grab the user record by ID from the API.
				var params = {auth: {username: username, auth: auth}};
				var promise = turtl.api.get('/users/'+this.id(), {}, params)
					.bind(this)
					.then(function(user) {
						turtl.api.set_auth(username, auth);
						this.set(user);
						this.write_cookie();
						if(!options.silent) this.trigger('login', this);
					})
					.catch(function(err) {
						log.error('user: problem grabbing user record: ', derr(err));
					});
				return promise;
			});
	},

	login_from_auth: function(auth)
	{
		if(!auth) return false;
		this.set({id: auth.uid});
		this.set('username', auth.username);
		this.auth = auth.auth;
		this.key = tcrypt.key_from_string(auth.key);
		this.logged_in = true;
		this.trigger('login', this);
	},

	login_from_cookie: function()
	{
		var cookie = localStorage[config.user_cookie];
		if(!cookie) return false;

		var userdata = JSON.parse(cookie);
		var key = tcrypt.key_from_string(userdata.k);
		var auth = userdata.a;
		delete userdata.k;
		delete userdata.a;
		this.key = key;
		this.auth = auth;
		this.set(userdata);
		this.logged_in = true;
		this.trigger('login', this);
	},

	/**
	 * add a new user.
	 *
	 * note that we don't do the usual model -> local db -> API pattern here
	 * because the local db relies on the user id (which is generated by the
	 * API) and because in the off-chance that there's a failure syncing the
	 * user record after the fact, it could serverely screw some things up in
	 * the client.
	 *
	 * instead, we post to the API, then once we have a full user record that we
	 * know is in the API, we wait for the local DB to init (poll it) and then
	 * add our shiny new user record to it.
	 */
	join: function(options)
	{
		options || (options = {});
		return Promise.resolve(tcrypt.asym.keygen())
			.bind(this)
			.then(function(keypair) {
				this.set({
					pubkey: tcrypt.to_base64(keypair.pubkey),
					privkey: tcrypt.to_base64(keypair.privkey),
				});
				// wipe the cache manually
				this.key = null;
				this.auth = null;
				return this.gen_auth(this.get('username'), this.get('password'));
			})
			.tap(function() {
				return this.serialize();
			})
			.then(function(auth) {
				var data = {
					auth: auth,
					username: this.get('username'),
					data: this.safe_json(),
				};
				return turtl.api.post('/users', data);
			})
			.tap(function(user) {
				// once we have the user record, wait until the user is logged
				// in. then we poll turtl.db until our local db object exists.
				// once we're sure we have it, we save the new user record to
				// the local db.
				this.bind('login', function() {
					this.unbind('login', 'user:join:add_local_record');
					var check_db = function()
					{
						if(!turtl.db)
						{
							check_db.delay(10, this);
							return false;
						}
						this.save();
					}.bind(this);
					check_db.delay(1, this);
				}.bind(this), 'user:join:add_local_record');
			});
	},

	/**
	 * Remove a user's account and all their data.
	 */
	delete_account: function(options)
	{
		return turtl.api._delete('/users/'+this.id())
			.then(function(res) {
				return turtl.wipe_local_db();
			})
			.then(function() {
				return turtl.user.logout();
			});
	},

	/**
	 * change the username/password.
	 *
	 * this assumes the current account has been verified, and does no checking
	 * itself.
	 *
	 * here's how this works:
	 *
	 *   1. generate a new master key using the new u/p
	 *   2. generate a new auth token using the new key
	 *   3. save the auth token to the API
	 *   4. use the new key to re-encrypt and save *every* keychain entry
	 *
	 * done! because all non-keychain objects are self-describing, we only need
	 * to encrypt keychain entries and we're good to go.
	 */
	change_password: function(new_username, new_password)
	{
		// TODO:
		// - using a tmp user object, generate new key/auth token with new
		//   username/password
		// - copy keychain to new object, re-encrypt new/copied keychain with
		//   new user key
		// - save the entire bunch to the API in one call (new username, new
		//   auth token, entire keychain)! no syncing here...it's either all or
		//   nothing.
		// - on success, REPLACE user's key/auth token/keychain with new ones
		//
		// no need to roll back on failure, because everything is a copy of a
		// copy of a copy. either everything works prefectly and we post it to
		// the server, or one tiny thing goes wrong and we post nothing.
	},

	write_cookie: function(options)
	{
		options || (options = {});

		var key, auth;
		if(!config.cookie_login) return false;

		var username = this.get('username');
		var password = this.get('password');
		var version = options.version || 0;

		if(!this.key && (!username || !password)) return;

		return this.gen_key(username, password, version).bind(this)
			.then(function(_key) {
				key = _key;
				return this.gen_auth();
			})
			.then(function(_auth) {
				auth = _auth;
				if(!key || !auth) return false;

				var save = {
					id: this.id(),
					username: this.get('username'),
					k: tcrypt.key_to_string(key),
					a: auth,
					storage: this.get('storage')
				};
				localStorage[config.user_cookie] = JSON.stringify(save);
			});
	},

	logout: function()
	{
		this.auth = null;
		this.key = null;
		this.logged_in = false;
		this.clear();
		delete localStorage[config.user_cookie];
		this.trigger('logout', this);
	},

	save_settings: function()
	{
		this.save().bind(this)
			.then(function(res) {
				this.trigger('saved', res);
			})
			.catch(function(err) {
				log.error('error: user.save_settings: ', derr(err));
				throw err;
			});
	},

	gen_key: function(username, password, version, options)
	{
		options || (options = {});

		var key = this.key;
		if(key && !options.skip_cache) return Promise.resolve(key);

		if(!username || !password) return Promise.resolve(false);

		switch(version) {
			case 0:
				var hashme = ['v', version, '/', username].join('');
				var saltlen = tcrypt.keygen_saltlen();
				var salt = tcrypt.sha512(tcrypt.from_string(hashme)).slice(0, saltlen);
				var key = tcrypt.keygen(password, salt);

				if(!options.skip_cache) this.key = key;

				return Promise.resolve(key);
				break;
			default:
				return Promise.reject(new Error('version '+version+' no implemented'));
				break;
		}
	},

	gen_auth: function(username, password, options)
	{
		options || (options = {});
		var version = options.version || 0;

		if(this.auth && !options.skip_cache) return Promise.resolve(this.auth);

		if(!username || !password) return Promise.reject(new Error('no username/password given to gen_auth'));

		// generate (or grab existing) the user's key based on username/password
		return this.gen_key(username, password, version, options)
			.bind(this)
			.then(function(key) {
				var nonce_len = tcrypt.noncelen();
				var nonce = tcrypt.sha512(username).slice(0, nonce_len);
				var pw_hash = tcrypt.to_hex(tcrypt.sha512(password));
				var user_record = pw_hash;
				var auth_bin = tcrypt.encrypt(key, tcrypt.from_string(user_record), {nonce: nonce});
				var auth = tcrypt.to_hex(auth_bin);
				return auth;
			})
			.tap(function(auth) {
				if(!options.skip_cache) this.auth = auth;
			});
	},

	test_auth: function()
	{
		var username = this.get('username');
		var password = this.get('password');
		return this.gen_auth(username, password, {skip_cache: true})
			.bind(this)
			.then(function(auth) {
				var params = {auth: {username: this.get('username'), auth: auth}};
				return turtl.api.post('/auth', {}, params);
			})
			.then(function(id) {
				return [id, {migrate: false}];
			})
			.catch(function(err) {
				throw err;
				// TODO: run old auths from migration system, prompt user to
				// migrate their account
			});
	},

	setting: function(key, val)
	{
		var settings = clone(this.get('settings') || {});
		if(val === undefined) return settings[key];
		settings[key] = val;
		this.set({settings: settings});
	},

	delete_setting: function(keyspec)
	{
		if(!keyspec) return;
		var settings = clone(this.get('settings') || {});

		var re = new RegExp('^'+keyspec.replace(/\*/g, '.*?')+'$');
		Object.keys(settings).forEach(function(key) {
			if(key.match(re)) delete settings[key];
		});
		this.set({settings: settings});
	},

	resend_confirmation: function()
	{
		return turtl.api.post('/users/confirmation/resend');
	},
});

// we don't actually use this collection for anything but syncing
var Users = SyncCollection.extend({
	model: User,
	local_table: 'user',

	sync_record_from_db: function(userdata, msg)
	{
		if(!userdata) return false;
		if(turtl.sync.should_ignore([msg.sync_id], {type: 'local'})) return false;

		turtl.user.set(userdata);
	},

	sync_record_from_api: function(item)
	{
		// make sure item.key is set so the correct record updates in the DB
		// (since we only ever get one user object synced: ours)
		item.key = 'user';
		return this.parent.apply(this, arguments);
	}
});

