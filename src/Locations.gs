/**
 * Retail locations. Gift cards are valid at every active location.
 * ADMIN manages the location list. Every authenticated employee can read it.
 */

function createLocation(request) {
  var actor = rhRequireActor_(request, { roles: ['ADMIN'], action: 'LOCATION_CREATE' });
  return rhWithLock_(function (ctx) {
    actor = rhReloadActor_(ctx, actor);
    var locationName = rhRequireText_(request.locationName, 'locationName', 2, 120);
    var locationType = rhRequireEnum_(request.locationType, RH_LOCATION_TYPES, 'locationType');
    var address = rhOptionalText_(request.address, 'address', 200);
    var phone = rhOptionalText_(request.phone, 'phone', 40);
    var existing = rhReadSheet_(ctx, RH_SHEET.LOCATIONS).records;
    for (var i = 0; i < existing.length; i++) {
      if (existing[i].location_name.toLowerCase() === locationName.toLowerCase()) {
        throw rhFail_('CONFLICT', 'A location with that name already exists');
      }
    }
    var now = rhNowIso_();
    var location = rhAppendRecord_(ctx, RH_SHEET.LOCATIONS, {
      location_id: rhNewId_(),
      location_name: locationName,
      location_type: locationType,
      address: address,
      phone: phone,
      is_active: true,
      created_at: now,
      updated_at: now
    });
    rhAudit_(ctx, {
      employee_id: actor.employee_id,
      action: 'LOCATION_CREATED',
      entity_type: 'LOCATION',
      entity_id: location.location_id,
      details: { location_type: locationType }
    });
    return rhPublicLocation_(location);
  });
}

function listLocations(request) {
  rhRequireActor_(request, { roles: ['ADMIN', 'MANAGER', 'EMPLOYEE'], action: 'LOCATION_LIST' });
  return rhWithLock_(function (ctx) {
    var records = rhReadSheet_(ctx, RH_SHEET.LOCATIONS).records;
    var locations = [];
    for (var i = 0; i < records.length; i++) locations.push(rhPublicLocation_(records[i]));
    locations.sort(function (a, b) {
      if (a.location_name < b.location_name) return -1;
      if (a.location_name > b.location_name) return 1;
      return 0;
    });
    return { locations: locations };
  });
}
